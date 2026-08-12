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
import {
  chooseMuxOutputFrame,
  splitMuxOutputData,
  type MuxClientMessage,
  type MuxFullOutputFrame,
  type MuxPaneScreen,
  type MuxServerMessage,
  type SessionListItem,
  type SessionListRow,
} from "@thumbmux/core";

export type WsLike = {
  send(data: string): unknown;
};

export interface TmuxDriver<SessionRow extends SessionListRow = SessionListItem> {
  listSessions(): SessionRow[];
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
  captureWithCursor?(
    session: string,
    opts: { startLine?: number; currentPaneOnly?: boolean },
  ): Promise<{
    content: string;
    cursor: RawCursorState | null;
    trailingBlanks: number;
    screen?: MuxPaneScreen | null;
  }>;
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
    opts: {
      previousContent: string | null;
      fullHistory: boolean;
      liveLineLimit: number;
      /** Replace the live archive window in place after a pane reflow. */
      replace?: boolean;
    },
  ): { liveContent: string };
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

export interface MuxHooks<
  WS extends WsLike = WsLike,
  SessionRow extends SessionListRow = SessionListItem,
> {
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
  /** Backpressure lifecycle for host telemetry/alerting. Never affects mux behaviour. */
  onBackpressure?(ws: WS, event: "blocked" | "drained" | "closed", info: { blockedMs: number; bufferedBytes?: number }): void;
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

export type TmuxWsMuxOptions<
  WS extends WsLike = WsLike,
  SessionRow extends SessionListRow = SessionListItem,
> = {
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
  pollNormalMs?: number;      // default 250 (4 FPS)
  pollBurstMs?: number;       // default 100 (10 FPS after keystroke)
  burstDurationMs?: number;   // default 5000
  sessionListIntervalMs?: number; // default 5000
  pipeReconcileMs?: number;
  /** unpiped sessions: max ms between reconcile captures when the
   * (second-resolution) tmux activity gate reports no change */
  pollReconcileMs?: number;   // default 3000
  /** Outbound backpressure. Default enabled — see MuxBackpressureOptions. */
  backpressure?: MuxBackpressureOptions<WS>;
  log?: (...args: unknown[]) => void;
  logError?: (...args: unknown[]) => void;
};

const DEFAULT_PROFILE: SessionProfile = { resize: true, currentPaneOnly: false, archive: true };
const EMPTY_HISTORY_PAGE = { lines: [], startLine: null, hasMore: false };

export class TmuxWsMux<
  WS extends WsLike = WsLike,
  SessionRow extends SessionListRow = SessionListItem,
> {
  private compressFrames = false;

  /** Send one frame; with compressFrames, opt into Bun's per-message deflate. */
  private wsSend(ws: any, data: string) {
    if (this.compressFrames) return ws.send(data, true);
    return ws.send(data);
  }
  private driver: TmuxDriver<SessionRow>;
  private pipes: PipeManagerLike | null;
  private archive: HistoryArchiveLike | null;
  private hooks: MuxHooks<WS, SessionRow>;
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
  /** Client hint remembered from the latest `sessions_subscribe` for this socket
   * (fed to `filterSessionList` on every delivery). Cleared on unsubscribe. */
  private sessionListClients = new Map<WS, unknown>();
  private contents = new Map<string, string>();
  private hashes = new Map<string, string>();
  private lastActivity = new Map<string, number>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private sessionListInterval: ReturnType<typeof setInterval> | null = null;
  /** Change-detection key for the UNFILTERED provider result only. Never store
   * a filtered projection here — a narrow view would suppress a real global
   * change for every other socket. */
  private lastSessionsJson = "";
  private inFlight = false;
  private currentRate: number;
  private burstTimer: ReturnType<typeof setTimeout> | null = null;
  private piped = new Set<string>();
  private immediateCaptureTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private queuedCapturesInFlight = new Set<string>();
  private queuedCapturesPending = new Set<string>();
  private queuedCapturesFullHistory = new Set<string>();
  /** Tail promise per session so callers (poll) can await the whole chain. */
  private queuedCaptureTails = new Map<string, Promise<void>>();
  /** Viewer-set owners currently consuming a full-history queue intent. A
   * WeakSet keeps that intent attached to the async lifecycle across rename. */
  private fullHistoryCaptureOwners = new WeakSet<Set<WS>>();
  private captureStartLines = new Map<string, number>();
  private archiveSeeded = new Set<string>();
  /** Sessions whose next successful archive ingest must replace, not append,
   * because accepted geometry changed tmux's physical line wrapping. Each
   * resize gets a monotonic generation so stale in-flight captures cannot
   * consume intent created after they started. */
  private pendingArchiveReflows = new Map<string, number>();
  /** Latest accepted geometry generation for each session. Captures snapshot
   * this before awaiting the driver and discard themselves if it changes. */
  private geometryGenerations = new Map<string, number>();
  private geometryGeneration = 0;
  private lastReconcileCapture = new Map<string, number>();
  private lastAppliedGeometry = new Map<string, { cols: number; rows: number }>();
  private sessionListProvider: () => readonly SessionRow[];
  /** per-session, per-socket tail preference (undefined = full snapshots) */
  private tails = new Map<string, Map<WS, number>>();
  /** Per-session viewers whose latest subscription opted into delta output frames. */
  private deltaSubscribers = new Map<string, Set<WS>>();
  /** Last successfully delivered raw base, after each viewer's tail slice. */
  private outputBases = new Map<string, Map<WS, string[]>>();
  /** Viewers which must receive a complete frame before a delta can resume. */
  private pendingOutputFulls = new Map<string, Set<WS>>();
  /** Complete frames whose reset marker must survive a failed send. */
  private pendingOutputResets = new Map<string, Map<WS, "resize" | "resync">>();
  /** last cursor broadcast per session — attached to cached first paints so
   * a new viewer of a static pane still gets a caret */
  private lastCursor = new Map<string, { row: number; col: number } | null>();
  /** last pane screen-mode sample per session — attached like lastCursor so a
   * new viewer of a static pane still learns alt/mouse without a content change */
  private lastScreen = new Map<string, MuxPaneScreen | null>();
  private pipeDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pipeMaxTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pollCounter = 0;

  // ── Outbound backpressure (per SOCKET — one outbound queue per connection) ──
  private bpEnabled: boolean;
  private bpMaxBufferedBytes: number;
  private bpMaxBlockedMs: number;
  private bpBufferedAmount?: (ws: WS) => number | undefined;
  private bpClose?: (ws: WS, reason: string) => void;
  /** Sockets whose last send returned -1 and have not yet drained. */
  private blockedSockets = new Map<WS, { since: number }>();
  /** Chronically slow sockets we have already shed (never push again). */
  private shedSockets = new Set<WS>();
  /** Blocked sockets that missed a session-list push and need one on drain. */
  private owedSessionList = new Set<WS>();
  /**
   * Per-socket timer that enforces `maxBlockedMs` as a real timeout (A3-9).
   * Cleared on drain/shed/unsubscribe. Without this, a blocked peer that never
   * receives another server push stays open forever.
   */
  private blockedTimeouts = new Map<WS, ReturnType<typeof setTimeout>>();

  constructor(opts: TmuxWsMuxOptions<WS, SessionRow>) {
    this.compressFrames = opts.compressFrames === true;
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
    const bp = opts.backpressure ?? {};
    this.bpEnabled = bp.enabled !== false;
    this.bpMaxBufferedBytes = bp.maxBufferedBytes ?? 8 * 1024 * 1024;
    this.bpMaxBlockedMs = bp.maxBlockedMs ?? 30_000;
    this.bpBufferedAmount = bp.bufferedAmount;
    this.bpClose = bp.close;
  }

  setSessionListProvider(provider?: () => readonly SessionRow[]) {
    this.sessionListProvider = provider ?? (() => this.driver.listSessions());
    this.lastSessionsJson = "";
  }

  subscribe(session: string, ws: WS, client?: unknown, opts: { tail?: number; delta?: boolean } = {}) {
    this.hooks.onSubscribe?.(session, ws, client);
    if (this.hooks.canSubscribe?.(session, ws, client) === false) return;
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
    this.setDeltaSubscription(session, ws, opts.delta === true);
    // A new subscription, reconnect, or tail preference change must establish
    // its own raw (post-tail) full base before it can receive a delta.
    this.invalidateOutputBase(session, ws);
    this.requireFullOutput(session, ws);
    const profile = this.profileOf(session);
    const cachedContent = this.contents.get(session);
    const resizeCapturePending = this.pendingArchiveReflows.has(session);
    if (resizeCapturePending) {
      // contents still describes the previous physical wrapping until the
      // matching resize capture succeeds. Never establish a new viewer's base
      // from that stale cache or consume its reset before the reflowed frame.
      this.requireResetOutput(session, ws, "resize");
    }
    if (cachedContent !== undefined && !resizeCapturePending) {
      this.sendOutputFrame(session, ws, {
        channel: session,
        type: "output",
        data: this.contentFor(session, ws, cachedContent),
        cursor: this.lastCursor.get(session) ?? null,
        ...(this.lastScreen.has(session) ? { screen: this.lastScreen.get(session) ?? null } : {}),
      });
      // Cached pane content is only a fast first paint. Always follow it with a
      // real capture so a reopened terminal cannot stay behind the live tmux pane
      // if pipe-pane missed a signal while another viewer kept the cache alive.
      // Widen the refresh back to the full live scrollback window; otherwise a
      // cache kept alive by another viewer can stay stuck on the small initial
      // capture window and make terminal scrolling feel truncated.
      this.captureStartLines.set(session, this.DEFAULT_CAPTURE_START_LINE);
    } else if (!resizeCapturePending) {
      // After a successful seed, always reopen at the full live-window depth.
      // A narrow bootstrap (INITIAL = -min(250, liveLineLimit)) does not abut
      // the archive boundary (archive ends at total−liveLineLimit; bootstrap
      // begins near total−250−paneRows). Hosts that only reconcile when the mux
      // still holds previousContent — which dropSessionState clears on the last
      // unsubscribe — permanently lose the rows in between. history_expand only
      // returns what was archived; it cannot invent the missing seam.
      // Before the seed completes, keep the small initial window for the first
      // paint; the full-history capture path ignores captureStartLines anyway.
      const startLine = this.archiveSeeded.has(session)
        ? this.DEFAULT_CAPTURE_START_LINE
        : this.INITIAL_CAPTURE_START_LINE;
      this.captureStartLines.set(session, startLine);
    }
    const wantsArchive = profile.archive && !this.archiveSeeded.has(session) && !(opts.tail && opts.tail > 0);
    this.queueCapture(session, { fullHistory: wantsArchive });
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
    this.forgetOutputViewer(session, ws);
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
    this.sessionListClients.delete(ws);
    for (const t of this.tails.values()) t.delete(ws);
    this.forgetOutputSocket(ws);
    this.clearBackpressureState(ws);
    for (const [session, set] of this.subscribers) {
      set.delete(ws);
      if (set.size === 0) {
        this.dropSessionState(session);
      }
    }
    this.maybeStopPolling();
    this.refreshSessionListSchedule();
  }

  /** True while this socket is being skipped because it has not drained. */
  isBackpressured(ws: WS): boolean {
    return this.blockedSockets.has(ws);
  }

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
  handleDrain(ws: WS): void {
    if (this.shedSockets.has(ws)) return;

    // A3-5: a real drop (status 0) records session-list debt without marking
    // the socket blocked. Allow drain to settle that debt even when there is
    // no blocked episode to resume — otherwise the only recovery path is a
    // provider-list change.
    if (this.blockedSockets.has(ws)) {
      // Shared resume: clear blocked mark + fire "drained".
      this.resumeBlockedSocket(ws, this.readBufferedAmount(ws));

      // Explicit catch-up (handleDrain only): one frame per session from CURRENT
      // cached state only for sessions where this socket still has a pending
      // full/reset marker (set while we skipped pushes). No history replay.
      // Auto-resume skips this loop — the in-flight broadcast already carries
      // pendingOutputFulls and delivers a complete snapshot in that same pass.
      for (const [session, viewers] of this.subscribers) {
        if (!viewers.has(ws)) continue;
        const pendingFull = this.pendingOutputFulls.get(session)?.has(ws) === true;
        const pendingReset = this.pendingOutputResets.get(session)?.has(ws) === true;
        if (!pendingFull && !pendingReset) continue;
        const cached = this.contents.get(session);
        if (cached === undefined) continue;
        this.sendOutputFrame(session, ws, {
          channel: session,
          type: "output",
          data: this.contentFor(session, ws, cached),
          cursor: this.lastCursor.get(session) ?? null,
          ...(this.lastScreen.has(session) ? { screen: this.lastScreen.get(session) ?? null } : {}),
        });
        // If re-blocked mid catch-up, remaining sessions stay pending for the next drain.
        if (this.blockedSockets.has(ws) || this.shedSockets.has(ws)) break;
      }
    }

    // Session-list debt after catch-up (may re-block above → leave debt for next resume).
    // Also settles drop-without-block debt (status 0 on list send).
    this.settleSessionListDebt(ws);
  }

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
  private resumeBlockedSocket(ws: WS, bufferedBytes: number | undefined): boolean {
    if (this.shedSockets.has(ws)) return false;
    const blocked = this.blockedSockets.get(ws);
    if (!blocked) return false;

    const blockedMs = Date.now() - blocked.since;
    this.clearBlockedTimeout(ws);
    this.blockedSockets.delete(ws);
    this.hooks.onBackpressure?.(ws, "drained", {
      blockedMs,
      bufferedBytes,
    });
    return true;
  }

  /** Push an owed session list if the socket is clear (not blocked / not shed). */
  private settleSessionListDebt(ws: WS): void {
    if (this.owedSessionList.has(ws) && !this.blockedSockets.has(ws) && !this.shedSockets.has(ws)) {
      this.owedSessionList.delete(ws);
      this.pushSessionListTo(ws);
    }
  }

  /** Drop per-socket backpressure marks so a reused socket object starts clean. */
  private clearBackpressureState(ws: WS) {
    this.clearBlockedTimeout(ws);
    this.blockedSockets.delete(ws);
    this.shedSockets.delete(ws);
    this.owedSessionList.delete(ws);
  }

  private clearBlockedTimeout(ws: WS) {
    const timer = this.blockedTimeouts.get(ws);
    if (timer) clearTimeout(timer);
    this.blockedTimeouts.delete(ws);
  }

  /** Arm a one-shot shed timer so maxBlockedMs is enforced without a next push. */
  private armBlockedTimeout(ws: WS) {
    this.clearBlockedTimeout(ws);
    if (!this.bpEnabled) return;
    if (!(this.bpMaxBlockedMs > 0) || !Number.isFinite(this.bpMaxBlockedMs)) return;
    const timer = setTimeout(() => {
      this.blockedTimeouts.delete(ws);
      if (this.shedSockets.has(ws)) return;
      if (!this.blockedSockets.has(ws)) return;
      this.maybeShed(ws, "timeout");
    }, this.bpMaxBlockedMs);
    this.blockedTimeouts.set(ws, timer);
  }

  private readBufferedAmount(ws: WS): number | undefined {
    if (this.bpBufferedAmount) return this.bpBufferedAmount(ws);
    const any = ws as any;
    if (typeof any.getBufferedAmount === "function") {
      try { return any.getBufferedAmount(); } catch { return undefined; }
    }
    return undefined;
  }

  private closeSlowSocket(ws: WS, reason: string) {
    if (this.bpClose) {
      try { this.bpClose(ws, reason); } catch {}
      return;
    }
    const any = ws as any;
    if (typeof any.close === "function") {
      try { any.close(1013, reason); } catch {}
    }
  }

  /**
   * Mark a socket blocked after a -1 enqueue. Fires onBackpressure("blocked")
   * once per blocked episode (not per frame). Then evaluate shed thresholds.
   */
  private markBlocked(ws: WS) {
    if (!this.bpEnabled) return;
    if (this.shedSockets.has(ws)) return;
    if (!this.blockedSockets.has(ws)) {
      this.blockedSockets.set(ws, { since: Date.now() });
      this.hooks.onBackpressure?.(ws, "blocked", {
        blockedMs: 0,
        bufferedBytes: this.readBufferedAmount(ws),
      });
      // Real timeout — not only "check on next push" (A3-9).
      this.armBlockedTimeout(ws);
    }
    this.maybeShed(ws, "backpressure");
  }

  /**
   * Shed a chronically slow socket. Invokes close once, fires onBackpressure
   * ("closed"), and records the socket so we never push to it again.
   *
   * Do NOT call unsubscribeAll here — the host's own socket-close handler owns
   * that path (Bun's `websocket.close` / our `unsubscribeAll`). Calling it
   * from shed would fire hooks.onSocketClose twice.
   */
  private shedSocket(ws: WS, reason: string) {
    if (this.shedSockets.has(ws)) return;
    const blocked = this.blockedSockets.get(ws);
    const blockedMs = blocked ? Date.now() - blocked.since : 0;
    const bufferedBytes = this.readBufferedAmount(ws);
    this.shedSockets.add(ws);
    this.clearBlockedTimeout(ws);
    this.blockedSockets.delete(ws);
    this.closeSlowSocket(ws, reason);
    this.hooks.onBackpressure?.(ws, "closed", { blockedMs, bufferedBytes });
  }

  /** Evaluate buffered-byte / blocked-duration thresholds. */
  private maybeShed(ws: WS, why: string): boolean {
    if (!this.bpEnabled) return false;
    if (this.shedSockets.has(ws)) return true;
    const buffered = this.readBufferedAmount(ws);
    if (buffered !== undefined && buffered > this.bpMaxBufferedBytes) {
      this.shedSocket(ws, `backpressure:buffered>${this.bpMaxBufferedBytes}`);
      return true;
    }
    const blocked = this.blockedSockets.get(ws);
    if (blocked && Date.now() - blocked.since >= this.bpMaxBlockedMs) {
      this.shedSocket(ws, `backpressure:blocked>${this.bpMaxBlockedMs}ms`);
      return true;
    }
    return false;
  }

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
  private shouldSkipServerPush(ws: WS): boolean {
    if (!this.bpEnabled) return false;
    if (this.shedSockets.has(ws)) return true;
    if (!this.blockedSockets.has(ws)) return false;
    // Shed check must win over auto-resume.
    if (this.maybeShed(ws, "skip")) return true;
    // Self-heal when the adapter can measure and the queue has fully drained.
    const buffered = this.readBufferedAmount(ws);
    if (buffered === 0) {
      this.resumeBlockedSocket(ws, 0);
      // Owed session list now — same settlement path as handleDrain, without
      // the output catch-up loop (pendingOutputFulls already mark this socket
      // so the frame being built becomes a complete snapshot).
      this.settleSessionListDebt(ws);
      return false;
    }
    // Positive buffer, or adapter cannot report (undefined) → stay blocked.
    return true;
  }

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
  private sessionListDataFor(
    ws: WS,
    sessions: readonly SessionRow[],
    unfilteredJson: string,
    client: unknown,
  ): string | null {
    const filter = this.hooks.filterSessionList;
    if (!filter) return unfilteredJson;
    try {
      return JSON.stringify(filter(sessions, ws, client));
    } catch (e: any) {
      // Fail closed + surface the failure on the same channel subscribeSessions /
      // broadcastSessionList already use. Message text only — never the payload.
      const msg = e && typeof e.message === "string" ? e.message : String(e);
      this.logError("[thumbmux-mux] filterSessionList threw:", msg);
      return null;
    }
  }

  /** Best-effort session-list push for one socket (used on drain catch-up). */
  private pushSessionListTo(ws: WS) {
    try {
      const sessions = this.sessionListProvider();
      const unfilteredJson = JSON.stringify(sessions);
      // Do NOT assign lastSessionsJson here — catch-up is a per-socket delivery
      // and must not clobber global change-detection state. Reading a newer
      // provider result during drain and storing it as "already broadcast"
      // would suppress the next real broadcast for every other socket.
      const dataJson = this.sessionListDataFor(
        ws, sessions, unfilteredJson, this.sessionListClients.get(ws),
      );
      if (dataJson === null) return;
      const status = this.wsSend(ws, JSON.stringify({
        channel: "__sessions", type: "sessions", data: dataJson,
      } satisfies MuxServerMessage));
      if (status === 0) {
        // Real drop on catch-up: re-owe so a later drain can try again (A3-5).
        if (!this.shedSockets.has(ws)) this.owedSessionList.add(ws);
      } else if (status === -1) {
        this.markBlocked(ws);
      }
    } catch {}
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

  private screenEq(a: MuxPaneScreen | null | undefined, b: MuxPaneScreen | null | undefined): boolean {
    const x = a ?? null, y = b ?? null;
    if (x === null || y === null) return x === y;
    return x.alt === y.alt && x.mouseSgr === y.mouseSgr && x.mouseAny === y.mouseAny;
  }

  /**
   * Best-effort canonical output tap. Keep the absent-hook path allocation-free:
   * the frame object only exists for hosts that explicitly install the seam.
   * Hook and logger failures are both contained here so neither can fall into
   * captureAndBroadcastAsync's session-gone catch and disturb viewers.
   */
  private emitOutputHook(
    session: string,
    data: string,
    cursor: { row: number; col: number } | null,
    reset?: "resize" | "resync",
    screen?: MuxPaneScreen | null,
  ): void {
    const hook = this.hooks.onOutput;
    if (!hook) return;
    const frame: MuxFullOutputFrame = {
      channel: session,
      type: "output",
      data,
      cursor: cursor ? { ...cursor } : null,
      ...(screen !== undefined ? { screen: screen ? { ...screen } : null } : {}),
      ...(reset ? { reset } : {}),
    };
    try {
      hook(session, frame);
    } catch (cause: any) {
      let message = "unknown error";
      try {
        message = cause && typeof cause.message === "string" ? cause.message : String(cause);
      } catch {}
      try { this.logError("[thumbmux-mux] onOutput threw:", message); } catch {}
    }
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
    for (const t of this.blockedTimeouts.values()) clearTimeout(t);
    this.blockedTimeouts.clear();
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

  private outputBaseFor(session: string, ws: WS): string[] | undefined {
    return this.outputBases.get(session)?.get(ws);
  }

  private setDeltaSubscription(session: string, ws: WS, enabled: boolean) {
    if (!enabled) {
      const viewers = this.deltaSubscribers.get(session);
      viewers?.delete(ws);
      if (viewers?.size === 0) this.deltaSubscribers.delete(session);
      return;
    }
    let viewers = this.deltaSubscribers.get(session);
    if (!viewers) {
      viewers = new Set();
      this.deltaSubscribers.set(session, viewers);
    }
    viewers.add(ws);
  }

  private isDeltaSubscriber(session: string, ws: WS): boolean {
    return this.deltaSubscribers.get(session)?.has(ws) === true;
  }

  private invalidateOutputBase(session: string, ws: WS) {
    const bases = this.outputBases.get(session);
    if (!bases) return;
    bases.delete(ws);
    if (bases.size === 0) this.outputBases.delete(session);
  }

  private invalidateOutputBases(session: string) {
    this.outputBases.delete(session);
  }

  private requireFullOutput(session: string, ws: WS) {
    let viewers = this.pendingOutputFulls.get(session);
    if (!viewers) {
      viewers = new Set();
      this.pendingOutputFulls.set(session, viewers);
    }
    viewers.add(ws);
  }

  private requireResetOutput(session: string, ws: WS, reset: "resize" | "resync") {
    this.invalidateOutputBase(session, ws);
    let resets = this.pendingOutputResets.get(session);
    if (!resets) {
      resets = new Map();
      this.pendingOutputResets.set(session, resets);
    }
    resets.set(ws, reset);
  }

  private hasPendingOutputFrame(session: string, viewers: Iterable<WS>): boolean {
    const fulls = this.pendingOutputFulls.get(session);
    const resets = this.pendingOutputResets.get(session);
    for (const ws of viewers) {
      if (fulls?.has(ws) || resets?.has(ws)) return true;
    }
    return false;
  }

  private forgetOutputViewer(session: string, ws: WS) {
    this.setDeltaSubscription(session, ws, false);
    this.invalidateOutputBase(session, ws);
    const fulls = this.pendingOutputFulls.get(session);
    fulls?.delete(ws);
    if (fulls?.size === 0) this.pendingOutputFulls.delete(session);
    const resets = this.pendingOutputResets.get(session);
    resets?.delete(ws);
    if (resets?.size === 0) this.pendingOutputResets.delete(session);
  }

  private forgetOutputSocket(ws: WS) {
    for (const session of new Set([
      ...this.deltaSubscribers.keys(),
      ...this.outputBases.keys(),
      ...this.pendingOutputFulls.keys(),
      ...this.pendingOutputResets.keys(),
    ])) {
      this.forgetOutputViewer(session, ws);
    }
  }

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
  private sendGroupedOutputFrames(
    session: string,
    viewers: Iterable<WS>,
    content: string,
    cursor: { row: number; col: number } | null,
    opts: { onlyPending?: boolean; /** When set, use this data for every viewer (caller already sliced). */ fixedData?: string } = {},
  ): Map<WS, boolean> {
    type Group = {
      tail: number | undefined;
      reset: "resize" | "resync" | undefined;
      /** Present only for delta-eligible groups that share this base by identity. */
      base: string[] | undefined;
      sockets: WS[];
    };

    const results = new Map<WS, boolean>();

    // Full groups keyed by "tail\0reset"; delta groups nested base→group under
    // the same tail (reset is always undefined on the delta path).
    const fullGroups = new Map<string, Group>();
    const deltaByTail = new Map<number | undefined, Map<string[], Group>>();

    for (const ws of viewers) {
      const reset = this.pendingOutputResets.get(session)?.get(ws);
      const pendingFull = this.pendingOutputFulls.get(session)?.has(ws) === true;
      // Evaluate onlyPending BEFORE backpressure skip: a blocked socket with
      // NOTHING pending is left completely untouched (no requireFullOutput).
      // A blocked socket that DOES have a pending marker still gets
      // skip + requireFullOutput (no base advance) for drain catch-up.
      if (opts.onlyPending && reset === undefined && !pendingFull) continue;

      // Blocked/shed sockets are skipped out of the group so a slow peer never
      // stops healthy peers from receiving the shared serialized frame. A skip
      // must NOT advance base and must NOT clear pending full/reset markers —
      // requireFullOutput so drain can hand CURRENT truth later.
      if (this.shouldSkipServerPush(ws)) {
        if (!this.shedSockets.has(ws)) this.requireFullOutput(session, ws);
        results.set(ws, false);
        continue;
      }

      const tail = opts.fixedData !== undefined ? undefined : this.tails.get(session)?.get(ws);
      const forceFull = reset !== undefined || pendingFull;
      const base = this.outputBaseFor(session, ws);
      const useDelta = this.isDeltaSubscriber(session, ws) && !forceFull && base !== undefined;

      if (!useDelta) {
        const key = `${tail ?? ""}\0${reset ?? ""}`;
        let group = fullGroups.get(key);
        if (!group) {
          group = { tail, reset, base: undefined, sockets: [] };
          fullGroups.set(key, group);
        }
        group.sockets.push(ws);
      } else {
        let byBase = deltaByTail.get(tail);
        if (!byBase) {
          byBase = new Map();
          deltaByTail.set(tail, byBase);
        }
        // base is defined on the useDelta path
        const b = base!;
        let group = byBase.get(b);
        if (!group) {
          group = { tail, reset: undefined, base: b, sockets: [] };
          byBase.set(b, group);
        }
        group.sockets.push(ws);
      }
    }

    // contentFor once per distinct tail value across all groups (any socket
    // in the group shares that tail; contentFor only reads tails.get).
    const dataByTail = new Map<number | undefined, string>();

    // splitMuxOutputData once per distinct data string, and only if a delta
    // subscriber in that group actually succeeds. The resulting array is
    // SHARED across every successful viewer in the group — treat as immutable
    // (chooseMuxOutputFrame / muxCommonPrefixLength only read; base.slice()
    // copies). Do not mutate in place.
    const nextBaseByData = new Map<string, string[]>();

    const flushGroup = (group: Group) => {
      let data: string;
      if (opts.fixedData !== undefined) {
        data = opts.fixedData;
      } else {
        const cached = dataByTail.get(group.tail);
        if (cached !== undefined) {
          data = cached;
        } else {
          data = this.contentFor(session, group.sockets[0]!, content);
          dataByTail.set(group.tail, data);
        }
      }
      const full: MuxFullOutputFrame = {
        channel: session,
        type: "output",
        data,
        cursor,
        ...(this.lastScreen.has(session) ? { screen: this.lastScreen.get(session) ?? null } : {}),
      };
      const frame: MuxFullOutputFrame = group.reset ? { ...full, reset: group.reset } : full;
      const output = group.base === undefined
        ? frame
        : chooseMuxOutputFrame(frame, group.base);
      const serialized = JSON.stringify(output);

      for (const ws of group.sockets) {
        let ok = true;
        try {
          const status = this.wsSend(ws, serialized);
          // Bun reports a dropped frame as 0 and backpressure as -1. Structural
          // adapters commonly return void, which remains a successful handoff.
          //
          // -1 means the frame WAS enqueued and WILL be delivered in order, so
          // per-socket bookkeeping for THIS frame still advances (base, pending
          // markers). We only mark the socket blocked so subsequent SERVER-PUSHED
          // frames are skipped until handleDrain — never treat -1 as a drop.
          // status === 0 is a real drop: force a full retry, do not advance base.
          if (status === 0) {
            this.requireFullOutput(session, ws);
            ok = false;
          } else if (status === -1) {
            this.markBlocked(ws);
          }
        } catch {
          this.requireFullOutput(session, ws);
          ok = false;
        }
        results.set(ws, ok);
        if (!ok) continue;

        // Full-only viewers can never consume a split base. If a later subscribe
        // opts in, subscribe() invalidates and re-establishes the base with a
        // forced full frame first.
        if (this.isDeltaSubscriber(session, ws)) {
          let nextBase = nextBaseByData.get(data);
          if (!nextBase) {
            // Shared immutable next-base for every successful delta viewer that
            // received this same `data` string in this broadcast.
            nextBase = splitMuxOutputData(data);
            nextBaseByData.set(data, nextBase);
          }
          let bases = this.outputBases.get(session);
          if (!bases) {
            bases = new Map();
            this.outputBases.set(session, bases);
          }
          bases.set(ws, nextBase);
        }
        const fulls = this.pendingOutputFulls.get(session);
        fulls?.delete(ws);
        if (fulls?.size === 0) this.pendingOutputFulls.delete(session);
        const resets = this.pendingOutputResets.get(session);
        resets?.delete(ws);
        if (resets?.size === 0) this.pendingOutputResets.delete(session);
      }
    };

    for (const group of fullGroups.values()) flushGroup(group);
    for (const byBase of deltaByTail.values()) {
      for (const group of byBase.values()) flushGroup(group);
    }
    return results;
  }

  /**
   * Serialize and send a full-or-delta output frame for exactly one viewer.
   * Implemented as a one-element call into the grouped helper so single-socket
   * paths (subscribe, handleResync) share the same bookkeeping.
   * The base advances only after Bun accepts the frame (including -1: queued
   * under backpressure). A real drop/throw forces a complete retry, so a live
   * socket cannot remain stale when the pane goes idle immediately afterward.
   */
  private sendOutputFrame(session: string, ws: WS, full: MuxFullOutputFrame): boolean {
    // full.data is already tail-sliced by the caller — pass as fixedData so the
    // grouped helper does not re-apply the socket's tail preference.
    const results = this.sendGroupedOutputFrames(
      session,
      [ws],
      full.data,
      full.cursor ?? null,
      { fixedData: full.data },
    );
    return results.get(ws) === true;
  }

  /** A lost cursor-only frame must make that viewer eligible for a complete
   * retry. lastCursor is session-global, so otherwise the next idle sample
   * looks unchanged and the affected viewer can remain stale indefinitely.
   * While backpressured, cursor-only frames are suppressed and the viewer is
   * marked for a full output on drain (which carries the current cursor). */
  private sendCursorFrame(session: string, ws: WS, message: string): boolean {
    if (this.shouldSkipServerPush(ws)) {
      if (!this.shedSockets.has(ws)) this.requireFullOutput(session, ws);
      return false;
    }
    try {
      const status = this.wsSend(ws, message);
      if (status === 0) {
        this.requireFullOutput(session, ws);
        return false;
      }
      if (status === -1) this.markBlocked(ws);
      return true;
    } catch {
      this.requireFullOutput(session, ws);
      return false;
    }
  }

  private sendPendingOutputFrames(
    session: string,
    viewers: Iterable<WS>,
    content: string,
    cursor: { row: number; col: number } | null,
  ) {
    this.sendGroupedOutputFrames(session, viewers, content, cursor, { onlyPending: true });
  }

  /**
   * End one server-owned session lifecycle. Every current viewer receives one
   * final error frame and is detached, so later poll ticks cannot capture or
   * report the dead pane again. Durable history is retained unless explicitly
   * purged; notification and detachment are intentionally not optional.
   */
  invalidateSession(session: string, opts: InvalidateSessionOptions = {}): number {
    const viewers = [...(this.subscribers.get(session) ?? [])];
    this.dropSessionState(session);
    // Unlike an ordinary last-viewer unsubscribe, invalidation ends the tmux
    // lifecycle. A future session reusing this name must bootstrap afresh even
    // when the host deliberately retains its durable archive.
    this.archiveSeeded.delete(session);
    if (opts.purgeArchive) {
      try {
        this.archive?.dropSession?.(session);
      } catch (error: unknown) {
        try {
          const message = error instanceof Error ? error.message : String(error);
          this.logError(`[thumbmux-mux] archive dropSession error for "${session}":`, message);
        } catch {
          // Archive purge is best effort. A throwing logger must not undo the
          // already-completed viewer/session teardown.
        }
      }
    }
    // These collaborators may invoke host-provided logging. Invalidation has
    // already detached the lifecycle, so housekeeping failures must not hide
    // the terminal frame or change the public return value.
    try { this.maybeStopPolling(); } catch {}
    try { this.refreshSessionListSchedule(); } catch {}

    const message = JSON.stringify({
      channel: session,
      type: "error",
      data: opts.reason ?? "Session not found",
    } satisfies MuxServerMessage);
    for (const ws of viewers) {
      try {
        const status = this.wsSend(ws, message);
        if (status === -1) this.markBlocked(ws);
      } catch {}
    }
    return viewers.length;
  }

  private dropSessionState(session: string) {
    const viewers = this.subscribers.get(session);
    this.subscribers.delete(session);
    // In-flight captures hold this Set by reference. Emptying it prevents a
    // late result from reaching detached sockets even before its identity
    // guard observes that the map now owns a different lifecycle.
    viewers?.clear();
    this.tails.delete(session);
    this.deltaSubscribers.delete(session);
    this.outputBases.delete(session);
    this.pendingOutputFulls.delete(session);
    this.pendingOutputResets.delete(session);
    this.lastCursor.delete(session);
    this.lastScreen.delete(session);
    this.contents.delete(session);
    this.hashes.delete(session);
    this.lastActivity.delete(session);
    this.captureStartLines.delete(session);
    this.pendingArchiveReflows.delete(session);
    this.geometryGenerations.delete(session);
    this.clearImmediateCapture(session);
    this.queuedCapturesPending.delete(session);
    this.queuedCapturesInFlight.delete(session);
    this.queuedCapturesFullHistory.delete(session);
    this.queuedCaptureTails.delete(session);
    this.clearPipeCaptureTimers(session);
    this.lastReconcileCapture.delete(session);
    this.lastAppliedGeometry.delete(session);
    if (this.piped.delete(session)) {
      try {
        this.pipes?.stopPipe(session);
      } catch (error: unknown) {
        try {
          const message = error instanceof Error ? error.message : String(error);
          this.logError(`[thumbmux-mux] stopPipe error for "${session}":`, message);
        } catch {
          // Pipe teardown is best effort; mux lifecycle teardown is not.
        }
      }
    }
  }

  subscribeSessions(ws: WS, client?: unknown) {
    this.sessionListSubscribers.add(ws);
    this.sessionListClients.set(ws, client);
    // Session-list is a server push. While blocked, remember the debt and
    // catch up on handleDrain — do not enqueue more onto a slow outbound queue.
    if (this.shouldSkipServerPush(ws)) {
      if (!this.shedSockets.has(ws)) this.owedSessionList.add(ws);
      this.refreshSessionListSchedule();
      return;
    }
    try {
      const sessions = this.sessionListProvider();
      // lastSessionsJson is assigned only after a successful handoff (A3-5).
      // A real drop (status 0) must not advance the global dedupe key or a hub
      // stays empty until the provider list happens to change.
      const json = JSON.stringify(sessions);
      const dataJson = this.sessionListDataFor(ws, sessions, json, client);
      if (dataJson === null) {
        // filterSessionList threw → fail closed: no frame this round.
        this.refreshSessionListSchedule();
        return;
      }
      const status = this.wsSend(ws, JSON.stringify({
        channel: "__sessions", type: "sessions", data: dataJson,
      } satisfies MuxServerMessage));
      if (status === 0) {
        // Real drop: keep debt so drain/retry can deliver; do not touch lastSessionsJson.
        if (!this.shedSockets.has(ws)) this.owedSessionList.add(ws);
      } else if (status === -1) {
        this.markBlocked(ws);
        this.lastSessionsJson = json;
      } else {
        this.lastSessionsJson = json;
      }
    } catch (e: any) {
      this.logError("[thumbmux-mux] subscribeSessions error:", e.message);
    }
    this.refreshSessionListSchedule();
  }

  unsubscribeSessions(ws: WS) {
    this.sessionListSubscribers.delete(ws);
    this.sessionListClients.delete(ws);
    // Opt-out must cancel list debt — otherwise handleDrain redelivers after
    // the principal left the subscription (A3-8).
    this.owedSessionList.delete(ws);
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
      const generation = ++this.geometryGeneration;
      this.geometryGenerations.set(session, generation);
      this.pendingArchiveReflows.set(session, generation);
      this.invalidateOutputBases(session);
      for (const viewer of this.subscribers.get(session) ?? []) {
        this.requireResetOutput(session, viewer, "resize");
      }
      // Same contract as subscribe: a post-seed capture must stay at live depth
      // so the archive/live seam cannot open on a geometry reflow either.
      this.captureStartLines.set(
        session,
        this.archiveSeeded.has(session)
          ? this.DEFAULT_CAPTURE_START_LINE
          : this.INITIAL_CAPTURE_START_LINE,
      );
      this.queueCapture(session, { fullHistory: false });
      this.refreshSessionListSchedule();
    } catch (e: any) {
      this.logError(`[thumbmux-mux] resize error for "${session}" to ${cols}x${rows}:`, e.message);
      try {
        ws && this.wsSend(ws, JSON.stringify({
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

  private reportArchiveReadErrorBestEffort(
    method: "readBefore" | "readAfter",
    session: string,
    error: unknown,
  ): void {
    try {
      const message = error instanceof Error ? error.message : String(error);
      this.logError(`[thumbmux-mux] archive ${method} error for "${session}":`, message);
    } catch {
      // The archive failure is represented by the empty-page reply below.
      // Logging is observability-only; retrying or using another logger could
      // throw recursively, so a logger failure must not replace that reply.
    }
  }

  expandHistory(session: string, ws: WS, beforeLine?: number | null, limit?: number) {
    let history: unknown = EMPTY_HISTORY_PAGE;
    // SessionProfile.archive gates history_expand as well as capture feed
    // (A3-6). A current-pane-only / non-archived profile must not surface
    // durable rows retained under the same session name.
    if (this.archive && this.profileOf(session).archive) {
      try {
        history = this.archive.readBefore(session, beforeLine ?? null, limit);
      } catch (e: unknown) {
        this.reportArchiveReadErrorBestEffort("readBefore", session, e);
      }
    }
    // No archive (or a failed archive read) answers with an explicit empty
    // page so the client stops waiting. The two cases stay wire-identical.
    try {
      this.wsSend(ws, JSON.stringify({
        channel: session,
        type: "history",
        data: JSON.stringify(history),
      } satisfies MuxServerMessage));
    } catch {}
  }

  expandHistoryAfter(session: string, ws: WS, afterLine: number | null, limit?: number) {
    let history: unknown = EMPTY_HISTORY_PAGE;
    if (this.archive?.readAfter && this.profileOf(session).archive) {
      try {
        history = this.archive.readAfter(session, afterLine, limit);
      } catch (e: unknown) {
        this.reportArchiveReadErrorBestEffort("readAfter", session, e);
      }
    }
    // A legacy archive without forward paging, a missing archive, and a
    // failed forward read all use the established empty-page wire response.
    try {
      this.wsSend(ws, JSON.stringify({
        channel: session,
        type: "history",
        data: JSON.stringify(history),
      } satisfies MuxServerMessage));
    } catch {}
  }

  /** Route a parsed client message. Convenience for hosts whose WS handler
   * is a thin switch — hosts with richer routing keep their own switch instead.
   * Answers client keepalive pings: the thumbmux/svelte client closes the
   * connection when a ping goes unanswered for 8s. */
  handleMessage(msg: MuxClientMessage, ws: WS) {
    switch (msg.type) {
      case "ping": try { ws.send('{"type":"pong"}'); } catch {} break;
      case "client_info": this.hooks.onClientInfo?.(ws, msg.client); break;
      case "subscribe": if (msg.session) this.subscribe(msg.session, ws, msg.client, { tail: msg.tail, delta: msg.delta }); break;
      case "unsubscribe": if (msg.session) this.unsubscribe(msg.session, ws, msg.client); break;
      case "keys": if (msg.session && msg.data !== undefined) this.handleKeys(msg.session, msg.data, ws, msg.client); break;
      case "resize": if (msg.session && msg.cols && msg.rows) this.handleResize(msg.session, msg.cols, msg.rows, ws, msg.client); break;
      case "sessions_subscribe": this.subscribeSessions(ws, msg.client); break;
      case "sessions_unsubscribe": this.unsubscribeSessions(ws); break;
      case "history_expand": if (msg.session) {
        if (msg.afterLine !== undefined) this.expandHistoryAfter(msg.session, ws, msg.afterLine, msg.limit);
        else this.expandHistory(msg.session, ws, msg.beforeLine, msg.limit);
      } break;
      case "resync": if (msg.session) this.handleResync(msg.session, ws); break;
    }
  }

  private handleResync(session: string, ws: WS) {
    this.requireResetOutput(session, ws, "resync");
    const cachedContent = this.contents.get(session);
    if (cachedContent !== undefined) {
      this.sendOutputFrame(session, ws, {
        channel: session,
        type: "output",
        data: this.contentFor(session, ws, cachedContent),
        cursor: this.lastCursor.get(session) ?? null,
        ...(this.lastScreen.has(session) ? { screen: this.lastScreen.get(session) ?? null } : {}),
      });
    }
    this.queueCapture(session);
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

  private clearPipeCaptureTimers(session: string) {
    const debounce = this.pipeDebounceTimers.get(session);
    if (debounce) clearTimeout(debounce);
    this.pipeDebounceTimers.delete(session);
    const maxWait = this.pipeMaxTimers.get(session);
    if (maxWait) clearTimeout(maxWait);
    this.pipeMaxTimers.delete(session);
  }

  private queueCapture(session: string, opts: { fullHistory?: boolean } = {}): Promise<void> {
    const viewers = this.subscribers.get(session);
    if (!viewers || viewers.size === 0) return Promise.resolve();
    if (opts.fullHistory) this.queuedCapturesFullHistory.add(session);

    if (this.queuedCapturesInFlight.has(session)) {
      this.queuedCapturesPending.add(session);
      // Return the tail so awaiters see the pending successor too.
      return this.queuedCaptureTails.get(session) ?? Promise.resolve();
    }

    this.queuedCapturesInFlight.add(session);
    const run = this.runQueuedCapture(session, viewers);
    this.queuedCaptureTails.set(session, run);
    return run;
  }

  private async runQueuedCapture(session: string, viewers: Set<WS>) {
    try {
      if (this.ownsSessionLifecycle(session, viewers)) {
        // Peek the one-shot full-history intent; do NOT delete it here.
        // captureAndBroadcastAsync consumes it only on success (A3-4). A
        // transient driver/archive failure must leave the intent for retry.
        const fullHistory = this.queuedCapturesFullHistory.has(session);
        if (fullHistory) this.fullHistoryCaptureOwners.add(viewers);
        await this.captureAndBroadcastAsync(session, viewers, { fullHistory });
      }
    } finally {
      this.fullHistoryCaptureOwners.delete(viewers);
      // invalidate → subscribe may start a new capture lane under the same
      // string key while this old Promise is still settling. The viewer Set is
      // the ownership token: an old finally must not erase the new lane.
      if (!this.ownsSessionLifecycle(session, viewers)) {
        this.queuedCaptureTails.delete(session);
        return;
      }
      this.queuedCapturesInFlight.delete(session);
      if (this.queuedCapturesPending.delete(session)) {
        // Chain the successor onto the same tail promise so poll awaiters
        // that grabbed this run still wait for the pending capture.
        const successor = this.queueCapture(session);
        this.queuedCaptureTails.set(session, successor);
        await successor;
      } else {
        this.queuedCaptureTails.delete(session);
      }
    }
  }

  // Debounce pipe signals with max wait: captures 15ms after last signal OR 100ms max
  private tryStartPipe(session: string) {
    if (!this.pipes) return;
    const viewers = this.subscribers.get(session);
    if (!viewers || viewers.size === 0) return;
    const ownsLifecycle = () => this.ownsSessionLifecycle(session, viewers);
    const started = this.pipes.startPipe(
      session,
      // onData: pipe-pane data = "dirty signal" → debounce with max wait
      (_data: string) => {
        if (!ownsLifecycle()) return;
        const doCapture = () => {
          if (!ownsLifecycle()) return;
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
        if (!ownsLifecycle()) return;
        this.piped.delete(session);
        this.queueCapture(session);
        try { this.log(`[thumbmux-mux] Pipe broken for "${session}" — resuming poll fallback`); } catch {}
      },
      // onRestarted: pipe recovered → just re-add to piped set
      () => {
        if (!ownsLifecycle()) return;
        this.piped.add(session);
        try { this.log(`[thumbmux-mux] Pipe restarted for "${session}"`); } catch {}
      },
    );

    if (started && ownsLifecycle()) {
      this.piped.add(session);
      try { this.log(`[thumbmux-mux] Pipe active for "${session}" — using as change trigger`); } catch {}
    }
  }

  handleSessionRename(oldSession: string, newSession: string) {
    // Always migrate subscribers (works for both piped and polled sessions)
    const previousViewers = this.subscribers.get(oldSession);
    const fullHistoryInFlight = previousViewers
      ? this.fullHistoryCaptureOwners.has(previousViewers)
      : false;
    // A fresh Set is the monotonic lifecycle owner. Reusing the old Set would
    // let an A→B→A rename make A's pre-rename capture current again.
    const viewers = previousViewers ? new Set(previousViewers) : undefined;
    if (viewers) {
      this.subscribers.set(newSession, viewers);
      this.subscribers.delete(oldSession);
    }
    const tails = this.tails.get(oldSession);
    if (tails) {
      this.tails.set(newSession, tails);
      this.tails.delete(oldSession);
    }
    const deltaSubscribers = this.deltaSubscribers.get(oldSession);
    if (deltaSubscribers) {
      this.deltaSubscribers.set(newSession, deltaSubscribers);
      this.deltaSubscribers.delete(oldSession);
    } else {
      this.deltaSubscribers.delete(newSession);
    }
    // A channel rename changes the identity of every client-side raw base.
    // Do not migrate them: the first new-channel output must be complete.
    this.outputBases.delete(oldSession);
    this.outputBases.delete(newSession);
    this.pendingOutputFulls.delete(oldSession);
    this.pendingOutputFulls.delete(newSession);
    this.pendingOutputResets.delete(oldSession);
    this.pendingOutputResets.delete(newSession);
    if (viewers) {
      for (const ws of viewers) this.requireFullOutput(newSession, ws);
    }
    if (this.lastCursor.has(oldSession)) {
      this.lastCursor.set(newSession, this.lastCursor.get(oldSession) ?? null);
      this.lastCursor.delete(oldSession);
    }
    if (this.lastScreen.has(oldSession)) {
      this.lastScreen.set(newSession, this.lastScreen.get(oldSession) ?? null);
      this.lastScreen.delete(oldSession);
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
    const geometryGeneration = this.geometryGenerations.get(oldSession);
    this.geometryGenerations.delete(oldSession);
    this.geometryGenerations.delete(newSession);
    if (geometryGeneration !== undefined) {
      this.geometryGenerations.set(newSession, geometryGeneration);
    }
    if (this.immediateCaptureTimers.has(oldSession)) {
      this.clearImmediateCapture(oldSession);
      this.scheduleImmediateCapture(newSession);
    }
    this.clearPipeCaptureTimers(oldSession);
    // Do not short-circuit these deletes: an owned in-flight capture can have
    // a pending successor, and its old-name marker must not survive the rename.
    const hadQueuedCapture = this.queuedCapturesPending.delete(oldSession);
    const hadCaptureInFlight = this.queuedCapturesInFlight.delete(oldSession);
    const needsFullHistory = this.queuedCapturesFullHistory.delete(oldSession)
      || fullHistoryInFlight;
    if (needsFullHistory) this.queuedCapturesFullHistory.add(newSession);
    if (hadQueuedCapture || hadCaptureInFlight) {
      this.queueCapture(newSession);
    }
    if (this.archiveSeeded.delete(oldSession)) {
      this.archiveSeeded.add(newSession);
    }
    const pendingArchiveReflow = this.pendingArchiveReflows.get(oldSession);
    this.pendingArchiveReflows.delete(oldSession);
    this.pendingArchiveReflows.delete(newSession);
    if (pendingArchiveReflow !== undefined) {
      this.pendingArchiveReflows.set(newSession, pendingArchiveReflow);
    }
    this.archive?.renameSession(oldSession, newSession);
    // Handle pipe: stop old, restart with new name
    this.pipes?.handleRename(oldSession);
    if (this.piped.has(oldSession)) {
      this.piped.delete(oldSession);
      this.tryStartPipe(newSession);
    }
    this.queueCapture(newSession);
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
    if (!this.ownsSessionLifecycle(session, viewers)) return;
    // Snapshot before the first await. A resize accepted while this capture is
    // in flight belongs to a later capture; the old physical wrapping must not
    // mutate archive/content/base/reset state or reach any viewer.
    const geometryGeneration = this.geometryGenerations.get(session);
    const archiveReflowGeneration = this.pendingArchiveReflows.get(session);
    try {
      const previousContent = this.contents.get(session) ?? null;
      const startLine = opts.fullHistory
        ? -Math.max(this.driver.getHistoryLimit(), this.liveLineLimit)
        : (this.captureStartLines.get(session) ?? this.DEFAULT_CAPTURE_START_LINE);
      this.lastReconcileCapture.set(session, Date.now());
      const profile = this.profileOf(session);
      // A bounded thumbnail capture is not an archive bootstrap. Feeding it
      // into a fresh FileHistoryArchive initializes an empty archive whose
      // live window can make the later full capture look unchanged, so the
      // older rows are never seeded. Keep serving that bounded capture
      // directly until a full-history capture establishes the archive; all
      // subsequent live captures resume normal archive reconciliation.
      const useArchive = profile.archive
        && this.archive !== null
        && (!!opts.fullHistory || this.archiveSeeded.has(session));
      const captureOpts = profile.currentPaneOnly ? { currentPaneOnly: true } : { startLine };
      let content: string;
      let rawCursor: RawCursorState | null = null;
      let trailingBlanks: number | null = null;
      /** undefined = driver did not sample; null/object = atomic sample */
      let rawScreen: MuxPaneScreen | null | undefined = undefined;
      if (this.driver.captureWithCursor) {
        const combined = await this.driver.captureWithCursor(session, captureOpts);
        content = combined.content;
        rawCursor = combined.cursor;
        trailingBlanks = combined.trailingBlanks;
        // Only treat as sampled when the driver actually returned the field.
        if (Object.prototype.hasOwnProperty.call(combined, "screen")) {
          rawScreen = combined.screen ?? null;
        }
      } else {
        content = await this.driver.capturePane(session, captureOpts);
      }
      if (!this.ownsSessionLifecycle(session, viewers)) return;
      if (this.geometryGenerations.get(session) !== geometryGeneration) {
        // queueCapture coalesces work per session. If the invalidated capture
        // owned the one-shot archive seed, hand that intent back to the queued
        // current-generation lane instead of silently consuming it. Calling
        // the queue also covers a direct capture whose resize recapture raced
        // all the way to completion before this stale await settled.
        if (opts.fullHistory) this.queueCapture(session, { fullHistory: true });
        return;
      }
      let liveContent: string;
      if (!useArchive) {
        liveContent = content;
      } else {
        // A3-4: isolate archive failures from driver failures. A transient
        // ingest throw must NOT be reported as "Session not found" (the pane
        // is live) and must leave the full-history seed intent for retry.
        try {
          liveContent = this.archive!.ingestSnapshot(session, content, {
            previousContent,
            fullHistory: !!opts.fullHistory,
            liveLineLimit: this.liveLineLimit,
            replace: archiveReflowGeneration !== undefined || undefined,
          }).liveContent;
        } catch (archiveCause) {
          if (!this.ownsSessionLifecycle(session, viewers)) return;
          const message = archiveCause instanceof Error ? archiveCause.message : String(archiveCause);
          try {
            this.logError(`[thumbmux-mux] archive ingest error for "${session}":`, message);
          } catch {}
          if (opts.fullHistory) this.queuedCapturesFullHistory.add(session);
          return;
        }
      }
      // The synchronous ingest returned successfully. Only now consume the
      // exact generation captured at entry. A throwing archive or a newer
      // resize must keep its generation pending for another capture. When the
      // profile has no active archive, consume the matching generation too:
      // there is no archive replacement to defer and retaining it would leak
      // one-shot state until a future profile change.
      if (archiveReflowGeneration !== undefined
        && this.pendingArchiveReflows.get(session) === archiveReflowGeneration) {
        this.pendingArchiveReflows.delete(session);
      }
      if (opts.fullHistory) {
        // A successful bootstrap capture widens every later live capture and
        // prevents late subscribers from repeating the expensive full-history
        // read. This bookkeeping is required even when the host uses the
        // default archive profile without providing an archive implementation.
        this.archiveSeeded.add(session);
        this.captureStartLines.set(session, this.DEFAULT_CAPTURE_START_LINE);
        // A subscriber may have queued another full capture while this one was
        // awaiting the driver. It is redundant now that the seed succeeded;
        // leave the pending lane intact so it refreshes at normal live depth.
        this.queuedCapturesFullHistory.delete(session);
        if (useArchive) {
          try { this.driver.setSessionHistoryLimit(session, this.liveLineLimit); } catch (e: any) {
            this.logError(`[thumbmux-mux] unable to lower history-limit for "${session}":`, e.message);
          }
        }
      }

      const hash = this.driver.hash(liveContent);
      this.contents.set(session, liveContent);
      if (hash === this.hashes.get(session)) {
        const atomicCursor = this.driver.captureWithCursor
          ? this.mapRawCursor(rawCursor, trailingBlanks ?? 0)
          : undefined;
        // null is an authoritative atomic sample (cursor hidden/copy-mode),
        // while undefined means this legacy driver did not sample at all.
        const cursor = atomicCursor !== undefined
          ? atomicCursor
          : (this.lastCursor.get(session) ?? null);
        const cursorMoved = atomicCursor !== undefined
          && !this.cursorEq(atomicCursor, this.lastCursor.get(session));
        // Screen is only authoritative on the atomic path when the driver
        // returned the field. undefined = not sampled this tick.
        const atomicScreen = rawScreen;
        const screenMoved = atomicScreen !== undefined
          && !this.screenEq(atomicScreen, this.lastScreen.get(session));
        if (this.hasPendingOutputFrame(session, viewers)) {
          // Remember who receives the complete pending frame before successful
          // sends clear their markers. A coincident cursor move still has to
          // reach every established viewer that did not need that full frame.
          const pendingViewers = new Set<WS>();
          const fulls = this.pendingOutputFulls.get(session);
          const resets = this.pendingOutputResets.get(session);
          for (const ws of viewers) {
            if (fulls?.has(ws) || resets?.has(ws)) pendingViewers.add(ws);
          }
          if (cursorMoved) this.lastCursor.set(session, atomicCursor);
          if (screenMoved) this.lastScreen.set(session, atomicScreen);
          if ((cursorMoved || screenMoved || archiveReflowGeneration !== undefined) && this.hooks.onOutput) {
            this.emitOutputHook(
              session,
              liveContent,
              cursor,
              archiveReflowGeneration !== undefined ? "resize" : undefined,
              this.lastScreen.has(session) ? (this.lastScreen.get(session) ?? null) : undefined,
            );
          }
          this.sendPendingOutputFrames(session, viewers, liveContent, cursor);
          // Non-pending viewers still need the change: screen lives only on
          // full/delta frames, so a screen move re-sends output (same content);
          // a pure cursor move stays on the lightweight cursor frame.
          if (screenMoved) {
            for (const ws of viewers) {
              if (pendingViewers.has(ws)) continue;
              this.sendOutputFrame(session, ws, {
                channel: session,
                type: "output",
                data: this.contentFor(session, ws, liveContent),
                cursor,
                screen: atomicScreen,
              });
            }
          } else if (cursorMoved) {
            const cursorMsg = JSON.stringify({
              channel: session,
              type: "cursor",
              cursor: atomicCursor,
            } satisfies MuxServerMessage);
            for (const ws of viewers) {
              if (pendingViewers.has(ws)) continue;
              this.sendCursorFrame(session, ws, cursorMsg);
            }
          }
          return;
        }
        // Content unchanged — but a cursor / screen that moved anyway must
        // still reach viewers. Only the atomic driver path does this: with
        // two-call sampling a mid-repaint sample could spam idle ticks.
        if (atomicCursor !== undefined || atomicScreen !== undefined) {
          if (cursorMoved && atomicCursor !== undefined) this.lastCursor.set(session, atomicCursor);
          if (screenMoved) this.lastScreen.set(session, atomicScreen!);
          if (screenMoved) {
            // Output carries screen (+ current cursor). Not a cursor-only frame:
            // MuxPaneScreen is only defined on full/delta wire shapes.
            const nextCursor = atomicCursor !== undefined
              ? atomicCursor
              : (this.lastCursor.get(session) ?? null);
            if (this.hooks.onOutput) {
              this.emitOutputHook(session, liveContent, nextCursor, undefined, atomicScreen);
            }
            this.sendGroupedOutputFrames(session, viewers, liveContent, nextCursor);
          } else if (cursorMoved && atomicCursor !== undefined) {
            if (this.hooks.onOutput) this.emitOutputHook(session, liveContent, atomicCursor);
            const cursorMsg = JSON.stringify({ channel: session, type: "cursor", cursor: atomicCursor } satisfies MuxServerMessage);
            for (const ws of viewers) {
              this.sendCursorFrame(session, ws, cursorMsg);
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
      if (!this.ownsSessionLifecycle(session, viewers)) return;
      // A3-7: recheck geometry generation after the legacy getCursor await.
      // Without this, a resize accepted during that second await installs a
      // reset marker that this stale capture then consumes with pre-resize
      // wrapping as the authoritative resize base.
      if (this.geometryGenerations.get(session) !== geometryGeneration) {
        if (opts.fullHistory) this.queueCapture(session, { fullHistory: true });
        return;
      }
      const cursor = this.mapRawCursor(rawCursor, trailingBlanks ?? 0);
      this.lastCursor.set(session, cursor);
      if (rawScreen !== undefined) this.lastScreen.set(session, rawScreen);
      if (this.hooks.onOutput) {
        this.emitOutputHook(
          session,
          liveContent,
          cursor,
          archiveReflowGeneration !== undefined ? "resize" : undefined,
          rawScreen,
        );
      }
      this.sendGroupedOutputFrames(session, viewers, liveContent, cursor);
    } catch (cause) {
      if (!this.ownsSessionLifecycle(session, viewers)) return;
      // Driver / outer failure — established wire contract for an unreachable
      // pane. Archive failures are handled above and never reach here (A3-4).
      try {
        const message = cause instanceof Error ? cause.message : String(cause);
        this.logError(`[thumbmux-mux] capture error for "${session}":`, message);
      } catch {}
      const errMsg = JSON.stringify({ channel: session, type: "error", data: "Session not found" } satisfies MuxServerMessage);
      for (const ws of viewers) {
        try { this.wsSend(ws, errMsg); } catch {}
      }
    }
  }

  private ownsSessionLifecycle(session: string, viewers: Set<WS>): boolean {
    return viewers.size > 0 && this.subscribers.get(session) === viewers;
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

      // Only capture sessions whose activity timestamp changed (or first-time seen).
      // A3-2: always enter through queueCapture so a slow prior capture cannot be
      // overtaken by a poll/pipe reconcile that finishes first and then loses to
      // the older result (stale pane regression for every viewer). Await the
      // returned queue tail so this poll tick still paces like the pre-queue
      // path (session-list cadence and inFlight gating stay meaningful).
      const tasks: Promise<void>[] = [];
      const nowMs = Date.now();
      for (const [session, viewers] of this.subscribers) {
        if (viewers.size === 0) continue;
        if (this.piped.has(session)) {
          const lastReconcile = this.lastReconcileCapture.get(session) ?? 0;
          if (nowMs - lastReconcile < this.PIPE_RECONCILE_INTERVAL) continue;
          tasks.push(this.queueCapture(session));
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

        tasks.push(this.queueCapture(session));
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

      // No filter hook: serialize ONCE and reuse the shared string for every
      // socket (byte-identical to pre-0.4). With a filter: per-socket data.
      const hasFilter = !!this.hooks.filterSessionList;
      const sharedMsg = hasFilter
        ? null
        : JSON.stringify({ channel: "__sessions", type: "sessions", data: json } satisfies MuxServerMessage);

      // Broadcast to all connected websockets (deduplicate). Blocked sockets
      // are skipped and marked as owing a session list for drain catch-up.
      // Per-socket dedupe of identical filtered pushes is OUT of scope — a
      // filtered socket may receive a repeat of its unchanged view when the
      // global list changes elsewhere (deliberate simplification).
      //
      // A3-5: advance lastSessionsJson only when the change is *accounted for*
      // — a successful/enqueued send, or a blocked socket that took list debt.
      // A pure status-0 drop is NOT accounted for: leave the dedupe key alone
      // so the unchanged provider list is retried, and record per-socket debt.
      const sent = new Set<WS>();
      let anyAccounted = false;
      const trySend = (ws: WS, client: unknown) => {
        if (sent.has(ws)) return;
        sent.add(ws);
        if (this.shouldSkipServerPush(ws)) {
          if (!this.shedSockets.has(ws)) this.owedSessionList.add(ws);
          anyAccounted = true; // debt will deliver current list on drain
          return;
        }
        try {
          let msg: string;
          if (sharedMsg !== null) {
            msg = sharedMsg;
          } else {
            const dataJson = this.sessionListDataFor(ws, sessions, json, client);
            if (dataJson === null) return; // fail closed
            msg = JSON.stringify({
              channel: "__sessions", type: "sessions", data: dataJson,
            } satisfies MuxServerMessage);
          }
          const status = this.wsSend(ws, msg);
          if (status === 0) {
            // Real drop: not enqueued. Debt for retry; do not count as accounted
            // so an all-drop broadcast can re-run without a provider change.
            if (!this.shedSockets.has(ws)) this.owedSessionList.add(ws);
          } else if (status === -1) {
            this.markBlocked(ws);
            anyAccounted = true; // enqueued under backpressure — will be delivered
          } else {
            anyAccounted = true;
          }
        } catch {}
      };
      for (const ws of this.sessionListSubscribers) {
        trySend(ws, this.sessionListClients.get(ws));
      }
      for (const viewers of this.subscribers.values()) {
        // Pane-only sockets may have no remembered client → undefined.
        for (const ws of viewers) trySend(ws, this.sessionListClients.get(ws));
      }
      // Unfiltered provider result only — never a filtered projection.
      if (anyAccounted) this.lastSessionsJson = json;
    } catch (e: any) {
      this.logError("[thumbmux-mux] broadcastSessionList error:", e.message);
    }
  }
}
