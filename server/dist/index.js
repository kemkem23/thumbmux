// src/ws-mux.ts
import {
  chooseMuxOutputFrame,
  splitMuxOutputData
} from "@thumbmux/core";
var DEFAULT_PROFILE = { resize: true, currentPaneOnly: false, archive: true };

class TmuxWsMux {
  compressFrames = false;
  wsSend(ws, data) {
    if (this.compressFrames)
      return ws.send(data, true);
    return ws.send(data);
  }
  driver;
  pipes;
  archive;
  hooks;
  profileOf;
  liveLineLimit;
  POLL_NORMAL;
  POLL_BURST;
  BURST_DURATION;
  SESSION_LIST_INTERVAL;
  PIPE_RECONCILE_INTERVAL;
  POLL_RECONCILE;
  INITIAL_CAPTURE_START_LINE;
  DEFAULT_CAPTURE_START_LINE;
  log;
  logError;
  subscribers = new Map;
  sessionListSubscribers = new Set;
  contents = new Map;
  hashes = new Map;
  lastActivity = new Map;
  interval = null;
  sessionListInterval = null;
  lastSessionsJson = "";
  inFlight = false;
  currentRate;
  burstTimer = null;
  piped = new Set;
  immediateCaptureTimers = new Map;
  queuedCapturesInFlight = new Set;
  queuedCapturesPending = new Set;
  queuedCapturesFullHistory = new Set;
  captureStartLines = new Map;
  archiveSeeded = new Set;
  pendingArchiveReflows = new Map;
  geometryGenerations = new Map;
  geometryGeneration = 0;
  lastReconcileCapture = new Map;
  lastAppliedGeometry = new Map;
  sessionListProvider;
  tails = new Map;
  deltaSubscribers = new Map;
  outputBases = new Map;
  pendingOutputFulls = new Map;
  pendingOutputResets = new Map;
  lastCursor = new Map;
  pipeDebounceTimers = new Map;
  pipeMaxTimers = new Map;
  pollCounter = 0;
  constructor(opts) {
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
    this.PIPE_RECONCILE_INTERVAL = opts.pipeReconcileMs ?? 1e4;
    this.POLL_RECONCILE = opts.pollReconcileMs ?? 3000;
    this.INITIAL_CAPTURE_START_LINE = -Math.min(250, this.liveLineLimit);
    this.DEFAULT_CAPTURE_START_LINE = -this.liveLineLimit;
    this.currentRate = this.POLL_NORMAL;
    this.log = opts.log ?? (() => {});
    this.logError = opts.logError ?? console.error;
    this.sessionListProvider = () => this.driver.listSessions();
  }
  setSessionListProvider(provider) {
    this.sessionListProvider = provider ?? (() => this.driver.listSessions());
    this.lastSessionsJson = "";
  }
  subscribe(session, ws, client, opts = {}) {
    this.hooks.onSubscribe?.(session, ws, client);
    let set = this.subscribers.get(session);
    if (!set) {
      set = new Set;
      this.subscribers.set(session, set);
    }
    set.add(ws);
    if (opts.tail && opts.tail > 0) {
      let t = this.tails.get(session);
      if (!t) {
        t = new Map;
        this.tails.set(session, t);
      }
      t.set(ws, Math.floor(opts.tail));
    } else {
      this.tails.get(session)?.delete(ws);
    }
    this.setDeltaSubscription(session, ws, opts.delta === true);
    this.invalidateOutputBase(session, ws);
    this.requireFullOutput(session, ws);
    const profile = this.profileOf(session);
    const cachedContent = this.contents.get(session);
    const resizeCapturePending = this.pendingArchiveReflows.has(session);
    if (resizeCapturePending) {
      this.requireResetOutput(session, ws, "resize");
    }
    if (cachedContent !== undefined && !resizeCapturePending) {
      this.sendOutputFrame(session, ws, {
        channel: session,
        type: "output",
        data: this.contentFor(session, ws, cachedContent),
        cursor: this.lastCursor.get(session) ?? null
      });
      this.captureStartLines.set(session, this.DEFAULT_CAPTURE_START_LINE);
    } else if (!resizeCapturePending) {
      this.captureStartLines.set(session, this.INITIAL_CAPTURE_START_LINE);
    }
    const wantsArchive = profile.archive && !this.archiveSeeded.has(session) && !(opts.tail && opts.tail > 0);
    this.queueCapture(session, { fullHistory: wantsArchive });
    this.ensurePolling();
    this.refreshSessionListSchedule();
    if (!this.piped.has(session)) {
      this.tryStartPipe(session);
    }
  }
  unsubscribe(session, ws, client) {
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
  unsubscribeAll(ws) {
    this.hooks.onSocketClose?.(ws);
    this.sessionListSubscribers.delete(ws);
    for (const t of this.tails.values())
      t.delete(ws);
    this.forgetOutputSocket(ws);
    for (const [session, set] of this.subscribers) {
      set.delete(ws);
      if (set.size === 0) {
        this.dropSessionState(session);
      }
    }
    this.maybeStopPolling();
    this.refreshSessionListSchedule();
  }
  mapRawCursor(raw, trailingBlanks) {
    if (!raw || !raw.visible)
      return null;
    const row = raw.paneHeight - 1 - trailingBlanks - raw.y;
    return { row, col: Math.max(0, raw.x) };
  }
  countTrailingBlanks(rawCapture) {
    const lines = rawCapture.replace(/\n$/, "").split(`
`);
    let last = lines.length;
    while (last > 0 && (lines[last - 1] ?? "").trim() === "")
      last--;
    return lines.length - last;
  }
  cursorEq(a, b) {
    const x = a ?? null, y = b ?? null;
    if (x === null || y === null)
      return x === y;
    return x.row === y.row && x.col === y.col;
  }
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.sessionListInterval) {
      clearInterval(this.sessionListInterval);
      this.sessionListInterval = null;
    }
    if (this.burstTimer) {
      clearTimeout(this.burstTimer);
      this.burstTimer = null;
    }
    for (const t of this.immediateCaptureTimers.values())
      clearTimeout(t);
    this.immediateCaptureTimers.clear();
    for (const t of this.pipeDebounceTimers.values())
      clearTimeout(t);
    this.pipeDebounceTimers.clear();
    for (const t of this.pipeMaxTimers.values())
      clearTimeout(t);
    this.pipeMaxTimers.clear();
    for (const session of this.piped)
      this.pipes?.stopPipe(session);
    this.piped.clear();
  }
  contentFor(session, ws, content) {
    const tail = this.tails.get(session)?.get(ws);
    if (!tail)
      return content;
    const lines = content.split(`
`);
    let end = lines.length;
    while (end > 0 && (lines[end - 1] ?? "").trim() === "")
      end--;
    if (end === 0)
      return "";
    return lines.slice(Math.max(0, end - tail), end).join(`
`);
  }
  outputBaseFor(session, ws) {
    return this.outputBases.get(session)?.get(ws);
  }
  setDeltaSubscription(session, ws, enabled) {
    if (!enabled) {
      const viewers2 = this.deltaSubscribers.get(session);
      viewers2?.delete(ws);
      if (viewers2?.size === 0)
        this.deltaSubscribers.delete(session);
      return;
    }
    let viewers = this.deltaSubscribers.get(session);
    if (!viewers) {
      viewers = new Set;
      this.deltaSubscribers.set(session, viewers);
    }
    viewers.add(ws);
  }
  isDeltaSubscriber(session, ws) {
    return this.deltaSubscribers.get(session)?.has(ws) === true;
  }
  invalidateOutputBase(session, ws) {
    const bases = this.outputBases.get(session);
    if (!bases)
      return;
    bases.delete(ws);
    if (bases.size === 0)
      this.outputBases.delete(session);
  }
  invalidateOutputBases(session) {
    this.outputBases.delete(session);
  }
  requireFullOutput(session, ws) {
    let viewers = this.pendingOutputFulls.get(session);
    if (!viewers) {
      viewers = new Set;
      this.pendingOutputFulls.set(session, viewers);
    }
    viewers.add(ws);
  }
  requireResetOutput(session, ws, reset) {
    this.invalidateOutputBase(session, ws);
    let resets = this.pendingOutputResets.get(session);
    if (!resets) {
      resets = new Map;
      this.pendingOutputResets.set(session, resets);
    }
    resets.set(ws, reset);
  }
  hasPendingOutputFrame(session, viewers) {
    const fulls = this.pendingOutputFulls.get(session);
    const resets = this.pendingOutputResets.get(session);
    for (const ws of viewers) {
      if (fulls?.has(ws) || resets?.has(ws))
        return true;
    }
    return false;
  }
  forgetOutputViewer(session, ws) {
    this.setDeltaSubscription(session, ws, false);
    this.invalidateOutputBase(session, ws);
    const fulls = this.pendingOutputFulls.get(session);
    fulls?.delete(ws);
    if (fulls?.size === 0)
      this.pendingOutputFulls.delete(session);
    const resets = this.pendingOutputResets.get(session);
    resets?.delete(ws);
    if (resets?.size === 0)
      this.pendingOutputResets.delete(session);
  }
  forgetOutputSocket(ws) {
    for (const session of new Set([
      ...this.deltaSubscribers.keys(),
      ...this.outputBases.keys(),
      ...this.pendingOutputFulls.keys(),
      ...this.pendingOutputResets.keys()
    ])) {
      this.forgetOutputViewer(session, ws);
    }
  }
  sendOutputFrame(session, ws, full) {
    const reset = this.pendingOutputResets.get(session)?.get(ws);
    const forceFull = reset !== undefined || this.pendingOutputFulls.get(session)?.has(ws) === true;
    const frame = reset ? { ...full, reset } : full;
    const base = this.outputBaseFor(session, ws);
    const output = !this.isDeltaSubscriber(session, ws) || forceFull || !base ? frame : chooseMuxOutputFrame(frame, base);
    try {
      const status = this.wsSend(ws, JSON.stringify(output));
      if (status === 0) {
        this.requireFullOutput(session, ws);
        return false;
      }
    } catch {
      this.requireFullOutput(session, ws);
      return false;
    }
    if (this.isDeltaSubscriber(session, ws)) {
      let bases = this.outputBases.get(session);
      if (!bases) {
        bases = new Map;
        this.outputBases.set(session, bases);
      }
      bases.set(ws, splitMuxOutputData(frame.data));
    }
    const fulls = this.pendingOutputFulls.get(session);
    fulls?.delete(ws);
    if (fulls?.size === 0)
      this.pendingOutputFulls.delete(session);
    const resets = this.pendingOutputResets.get(session);
    resets?.delete(ws);
    if (resets?.size === 0)
      this.pendingOutputResets.delete(session);
    return true;
  }
  sendCursorFrame(session, ws, message) {
    try {
      const status = this.wsSend(ws, message);
      if (status === 0) {
        this.requireFullOutput(session, ws);
        return false;
      }
      return true;
    } catch {
      this.requireFullOutput(session, ws);
      return false;
    }
  }
  sendPendingOutputFrames(session, viewers, content, cursor) {
    for (const ws of viewers) {
      if (!this.pendingOutputFulls.get(session)?.has(ws) && !this.pendingOutputResets.get(session)?.has(ws))
        continue;
      this.sendOutputFrame(session, ws, {
        channel: session,
        type: "output",
        data: this.contentFor(session, ws, content),
        cursor
      });
    }
  }
  dropSessionState(session) {
    this.subscribers.delete(session);
    this.tails.delete(session);
    this.deltaSubscribers.delete(session);
    this.outputBases.delete(session);
    this.pendingOutputFulls.delete(session);
    this.pendingOutputResets.delete(session);
    this.lastCursor.delete(session);
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
    this.lastReconcileCapture.delete(session);
    this.lastAppliedGeometry.delete(session);
    if (this.piped.has(session)) {
      this.pipes?.stopPipe(session);
      this.piped.delete(session);
    }
  }
  subscribeSessions(ws) {
    this.sessionListSubscribers.add(ws);
    try {
      const sessions = this.sessionListProvider();
      const json = JSON.stringify(sessions);
      this.lastSessionsJson = json;
      this.wsSend(ws, JSON.stringify({ channel: "__sessions", type: "sessions", data: json }));
    } catch (e) {
      this.logError("[thumbmux-mux] subscribeSessions error:", e.message);
    }
    this.refreshSessionListSchedule();
  }
  unsubscribeSessions(ws) {
    this.sessionListSubscribers.delete(ws);
    this.refreshSessionListSchedule();
  }
  handleResize(session, cols, rows, ws, client) {
    this.hooks.onResizeTelemetry?.(session, ws ?? null, { cols, rows }, client);
    if (!this.profileOf(session).resize)
      return;
    const verdict = this.hooks.onResizeRequest?.(session, ws ?? null, { cols, rows }, client) ?? { apply: true };
    if (!verdict.apply)
      return;
    this.applyGeometry(session, cols, rows, ws);
  }
  applyGeometry(session, cols, rows, ws) {
    try {
      const last = this.lastAppliedGeometry.get(session);
      if (last?.cols === cols && last.rows === rows)
        return;
      this.driver.resizeWindow(session, cols, rows);
      this.lastAppliedGeometry.set(session, { cols, rows });
      const generation = ++this.geometryGeneration;
      this.geometryGenerations.set(session, generation);
      this.pendingArchiveReflows.set(session, generation);
      this.invalidateOutputBases(session);
      for (const viewer of this.subscribers.get(session) ?? []) {
        this.requireResetOutput(session, viewer, "resize");
      }
      this.captureStartLines.set(session, this.INITIAL_CAPTURE_START_LINE);
      this.queueCapture(session, { fullHistory: false });
      this.refreshSessionListSchedule();
    } catch (e) {
      this.logError(`[thumbmux-mux] resize error for "${session}" to ${cols}x${rows}:`, e.message);
      try {
        ws && this.wsSend(ws, JSON.stringify({
          channel: session,
          type: "error",
          data: e.message ?? String(e)
        }));
      } catch {}
    }
  }
  handleKeys(session, data, ws, client) {
    if (ws)
      this.hooks.onKeys?.(session, ws, client);
    try {
      this.driver.sendKeys(session, data);
      if (this.piped.has(session))
        return;
      this.enterBurst();
      this.scheduleImmediateCapture(session);
    } catch (e) {
      this.logError(`[thumbmux-mux] sendKeys error for "${session}":`, e.message);
    }
  }
  expandHistory(session, ws, beforeLine, limit) {
    if (!this.archive) {
      try {
        this.wsSend(ws, JSON.stringify({
          channel: session,
          type: "history",
          data: JSON.stringify({ lines: [], startLine: null, hasMore: false })
        }));
      } catch {}
      return;
    }
    const history = this.archive.readBefore(session, beforeLine ?? null, limit);
    try {
      this.wsSend(ws, JSON.stringify({
        channel: session,
        type: "history",
        data: JSON.stringify(history)
      }));
    } catch {}
  }
  handleMessage(msg, ws) {
    switch (msg.type) {
      case "ping":
        try {
          ws.send('{"type":"pong"}');
        } catch {}
        break;
      case "subscribe":
        if (msg.session)
          this.subscribe(msg.session, ws, msg.client, { tail: msg.tail, delta: msg.delta });
        break;
      case "unsubscribe":
        if (msg.session)
          this.unsubscribe(msg.session, ws, msg.client);
        break;
      case "keys":
        if (msg.session && msg.data !== undefined)
          this.handleKeys(msg.session, msg.data, ws, msg.client);
        break;
      case "resize":
        if (msg.session && msg.cols && msg.rows)
          this.handleResize(msg.session, msg.cols, msg.rows, ws, msg.client);
        break;
      case "sessions_subscribe":
        this.subscribeSessions(ws);
        break;
      case "sessions_unsubscribe":
        this.unsubscribeSessions(ws);
        break;
      case "history_expand":
        if (msg.session)
          this.expandHistory(msg.session, ws, msg.beforeLine, msg.limit);
        break;
      case "resync":
        if (msg.session)
          this.handleResync(msg.session, ws);
        break;
    }
  }
  handleResync(session, ws) {
    this.requireResetOutput(session, ws, "resync");
    const cachedContent = this.contents.get(session);
    if (cachedContent !== undefined) {
      this.sendOutputFrame(session, ws, {
        channel: session,
        type: "output",
        data: this.contentFor(session, ws, cachedContent),
        cursor: this.lastCursor.get(session) ?? null
      });
    }
    this.queueCapture(session);
  }
  scheduleImmediateCapture(session) {
    this.clearImmediateCapture(session);
    this.immediateCaptureTimers.set(session, setTimeout(() => {
      this.immediateCaptureTimers.delete(session);
      this.queueCapture(session);
    }, 16));
  }
  clearImmediateCapture(session) {
    const timer = this.immediateCaptureTimers.get(session);
    if (!timer)
      return;
    clearTimeout(timer);
    this.immediateCaptureTimers.delete(session);
  }
  queueCapture(session, opts = {}) {
    const viewers = this.subscribers.get(session);
    if (!viewers || viewers.size === 0)
      return;
    if (opts.fullHistory)
      this.queuedCapturesFullHistory.add(session);
    if (this.queuedCapturesInFlight.has(session)) {
      this.queuedCapturesPending.add(session);
      return;
    }
    this.queuedCapturesInFlight.add(session);
    this.runQueuedCapture(session);
  }
  async runQueuedCapture(session) {
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
  tryStartPipe(session) {
    if (!this.pipes)
      return;
    const started = this.pipes.startPipe(session, (_data) => {
      const doCapture = () => {
        const d = this.pipeDebounceTimers.get(session);
        if (d)
          clearTimeout(d);
        this.pipeDebounceTimers.delete(session);
        const m = this.pipeMaxTimers.get(session);
        if (m)
          clearTimeout(m);
        this.pipeMaxTimers.delete(session);
        this.queueCapture(session);
      };
      const existing = this.pipeDebounceTimers.get(session);
      if (existing)
        clearTimeout(existing);
      this.pipeDebounceTimers.set(session, setTimeout(doCapture, 15));
      if (!this.pipeMaxTimers.has(session)) {
        this.pipeMaxTimers.set(session, setTimeout(doCapture, 100));
      }
    }, () => {
      this.log(`[thumbmux-mux] Pipe broken for "${session}" — resuming poll fallback`);
      this.piped.delete(session);
      this.queueCapture(session);
    }, () => {
      this.log(`[thumbmux-mux] Pipe restarted for "${session}"`);
      this.piped.add(session);
    });
    if (started) {
      this.piped.add(session);
      this.log(`[thumbmux-mux] Pipe active for "${session}" — using as change trigger`);
    }
  }
  handleSessionRename(oldSession, newSession) {
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
    const deltaSubscribers = this.deltaSubscribers.get(oldSession);
    if (deltaSubscribers) {
      this.deltaSubscribers.set(newSession, deltaSubscribers);
      this.deltaSubscribers.delete(oldSession);
    } else {
      this.deltaSubscribers.delete(newSession);
    }
    this.outputBases.delete(oldSession);
    this.outputBases.delete(newSession);
    this.pendingOutputFulls.delete(oldSession);
    this.pendingOutputFulls.delete(newSession);
    this.pendingOutputResets.delete(oldSession);
    this.pendingOutputResets.delete(newSession);
    if (viewers) {
      for (const ws of viewers)
        this.requireFullOutput(newSession, ws);
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
    if (this.queuedCapturesPending.delete(oldSession) || this.queuedCapturesInFlight.delete(oldSession)) {
      this.queueCapture(newSession);
    }
    if (this.queuedCapturesFullHistory.delete(oldSession)) {
      this.queuedCapturesFullHistory.add(newSession);
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
    this.pipes?.handleRename(oldSession);
    if (this.piped.has(oldSession)) {
      this.piped.delete(oldSession);
      this.tryStartPipe(newSession);
    }
    this.queueCapture(newSession);
  }
  enterBurst() {
    if (this.burstTimer)
      clearTimeout(this.burstTimer);
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
  restartPolling() {
    if (!this.interval)
      return;
    clearInterval(this.interval);
    this.interval = setInterval(() => this.poll(), this.currentRate);
  }
  async captureAndBroadcastAsync(session, viewers, opts = {}) {
    const geometryGeneration = this.geometryGenerations.get(session);
    const archiveReflowGeneration = this.pendingArchiveReflows.get(session);
    try {
      const previousContent = this.contents.get(session) ?? null;
      const startLine = opts.fullHistory ? -Math.max(this.driver.getHistoryLimit(), this.liveLineLimit) : this.captureStartLines.get(session) ?? this.DEFAULT_CAPTURE_START_LINE;
      this.lastReconcileCapture.set(session, Date.now());
      const profile = this.profileOf(session);
      const useArchive = profile.archive && this.archive !== null;
      const captureOpts = profile.currentPaneOnly ? { currentPaneOnly: true } : { startLine };
      let content;
      let rawCursor = null;
      let trailingBlanks = null;
      if (this.driver.captureWithCursor) {
        const combined = await this.driver.captureWithCursor(session, captureOpts);
        content = combined.content;
        rawCursor = combined.cursor;
        trailingBlanks = combined.trailingBlanks;
      } else {
        content = await this.driver.capturePane(session, captureOpts);
      }
      if (this.geometryGenerations.get(session) !== geometryGeneration) {
        if (opts.fullHistory)
          this.queueCapture(session, { fullHistory: true });
        return;
      }
      const liveContent = !useArchive ? content : this.archive.ingestSnapshot(session, content, {
        previousContent,
        fullHistory: !!opts.fullHistory,
        liveLineLimit: this.liveLineLimit,
        replace: archiveReflowGeneration !== undefined || undefined
      }).liveContent;
      if (archiveReflowGeneration !== undefined && this.pendingArchiveReflows.get(session) === archiveReflowGeneration) {
        this.pendingArchiveReflows.delete(session);
      }
      if (opts.fullHistory && useArchive) {
        this.archiveSeeded.add(session);
        this.captureStartLines.set(session, this.DEFAULT_CAPTURE_START_LINE);
        try {
          this.driver.setSessionHistoryLimit(session, this.liveLineLimit);
        } catch (e) {
          this.logError(`[thumbmux-mux] unable to lower history-limit for "${session}":`, e.message);
        }
      }
      const hash = this.driver.hash(liveContent);
      this.contents.set(session, liveContent);
      if (hash === this.hashes.get(session)) {
        const atomicCursor = this.driver.captureWithCursor ? this.mapRawCursor(rawCursor, trailingBlanks ?? 0) : undefined;
        const cursor2 = atomicCursor !== undefined ? atomicCursor : this.lastCursor.get(session) ?? null;
        const cursorMoved = atomicCursor !== undefined && !this.cursorEq(atomicCursor, this.lastCursor.get(session));
        if (this.hasPendingOutputFrame(session, viewers)) {
          const pendingViewers = new Set;
          const fulls = this.pendingOutputFulls.get(session);
          const resets = this.pendingOutputResets.get(session);
          for (const ws of viewers) {
            if (fulls?.has(ws) || resets?.has(ws))
              pendingViewers.add(ws);
          }
          if (cursorMoved)
            this.lastCursor.set(session, atomicCursor);
          this.sendPendingOutputFrames(session, viewers, liveContent, cursor2);
          if (cursorMoved) {
            const cursorMsg = JSON.stringify({
              channel: session,
              type: "cursor",
              cursor: atomicCursor
            });
            for (const ws of viewers) {
              if (pendingViewers.has(ws))
                continue;
              this.sendCursorFrame(session, ws, cursorMsg);
            }
          }
          return;
        }
        if (atomicCursor !== undefined) {
          if (cursorMoved) {
            this.lastCursor.set(session, atomicCursor);
            const cursorMsg = JSON.stringify({ channel: session, type: "cursor", cursor: atomicCursor });
            for (const ws of viewers) {
              this.sendCursorFrame(session, ws, cursorMsg);
            }
          }
        }
        return;
      }
      this.hashes.set(session, hash);
      if (!this.driver.captureWithCursor && this.driver.getCursor) {
        try {
          rawCursor = await this.driver.getCursor(session);
        } catch {
          rawCursor = null;
        }
        trailingBlanks = this.countTrailingBlanks(content);
      }
      const cursor = this.mapRawCursor(rawCursor, trailingBlanks ?? 0);
      this.lastCursor.set(session, cursor);
      for (const ws of viewers) {
        this.sendOutputFrame(session, ws, {
          channel: session,
          type: "output",
          data: this.contentFor(session, ws, liveContent),
          cursor
        });
      }
    } catch {
      const errMsg = JSON.stringify({ channel: session, type: "error", data: "Session not found" });
      for (const ws of viewers) {
        try {
          this.wsSend(ws, errMsg);
        } catch {}
      }
    }
  }
  ensurePolling() {
    if (this.interval)
      return;
    this.log(`[thumbmux-mux] Starting adaptive poll (${this.currentRate}ms)`);
    this.interval = setInterval(() => this.poll(), this.currentRate);
  }
  maybeStopPolling() {
    if (this.subscribers.size === 0 && this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      this.log(`[thumbmux-mux] Stopped shared poll interval (no subscribers)`);
    }
  }
  refreshSessionListSchedule() {
    const needsDedicatedListPolling = this.sessionListSubscribers.size > 0 && this.subscribers.size === 0;
    if (needsDedicatedListPolling) {
      if (this.sessionListInterval)
        return;
      this.sessionListInterval = setInterval(() => this.broadcastSessionList(), this.SESSION_LIST_INTERVAL);
      return;
    }
    if (this.sessionListInterval) {
      clearInterval(this.sessionListInterval);
      this.sessionListInterval = null;
    }
  }
  async poll() {
    if (this.inFlight)
      return;
    this.inFlight = true;
    try {
      this.pollCounter++;
      const activity = this.driver.getSessionActivity();
      const tasks = [];
      const nowMs = Date.now();
      for (const [session, viewers] of this.subscribers) {
        if (viewers.size === 0)
          continue;
        if (this.piped.has(session)) {
          const lastReconcile = this.lastReconcileCapture.get(session) ?? 0;
          if (nowMs - lastReconcile < this.PIPE_RECONCILE_INTERVAL)
            continue;
          tasks.push(this.captureAndBroadcastAsync(session, viewers));
          continue;
        }
        const currentActivity = activity.get(session);
        const previousActivity = this.lastActivity.get(session);
        if (currentActivity !== undefined && previousActivity !== undefined && currentActivity <= previousActivity) {
          const lastCap = this.lastReconcileCapture.get(session) ?? 0;
          if (nowMs - lastCap < this.POLL_RECONCILE)
            continue;
        }
        if (currentActivity !== undefined) {
          this.lastActivity.set(session, currentActivity);
        }
        tasks.push(this.captureAndBroadcastAsync(session, viewers));
      }
      if (tasks.length > 0) {
        await Promise.allSettled(tasks);
      }
      const sessionListInterval = Math.max(Math.round(this.SESSION_LIST_INTERVAL / this.currentRate), 1);
      if (this.pollCounter % sessionListInterval === 0) {
        this.broadcastSessionList();
      }
    } finally {
      this.inFlight = false;
    }
  }
  broadcastSessionList() {
    try {
      const sessions = this.sessionListProvider();
      const json = JSON.stringify(sessions);
      if (json === this.lastSessionsJson)
        return;
      this.lastSessionsJson = json;
      const msg = JSON.stringify({ channel: "__sessions", type: "sessions", data: json });
      const sent = new Set;
      for (const ws of this.sessionListSubscribers) {
        if (sent.has(ws))
          continue;
        try {
          this.wsSend(ws, msg);
        } catch {}
        sent.add(ws);
      }
      for (const viewers of this.subscribers.values()) {
        for (const ws of viewers) {
          if (!sent.has(ws)) {
            try {
              this.wsSend(ws, msg);
            } catch {}
            sent.add(ws);
          }
        }
      }
    } catch (e) {
      this.logError("[thumbmux-mux] broadcastSessionList error:", e.message);
    }
  }
}
// src/bun-driver.ts
var LARGE_INPUT_THRESHOLD_BYTES = 8 * 1024;
function run(args) {
  const p = Bun.spawnSync(["tmux", ...args]);
  if (p.exitCode !== 0)
    throw new Error(p.stderr.toString().trim() || `tmux ${args[0]} failed`);
  return p.stdout.toString();
}
function runWithStdin(args, stdin) {
  const p = Bun.spawnSync(["tmux", ...args], { stdin, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0)
    throw new Error(p.stderr.toString().trim() || `tmux ${args[0]} failed`);
  return p.stdout.toString();
}
function sendLargeInput(session, bytes) {
  const bufferName = `thumbmux-input-${crypto.randomUUID()}`;
  try {
    runWithStdin(["load-buffer", "-b", bufferName, "-"], bytes);
    run(["paste-buffer", "-d", "-r", "-b", bufferName, "-t", session]);
  } finally {
    try {
      run(["delete-buffer", "-b", bufferName]);
    } catch {}
  }
}
function parseCursorLine(line) {
  const [x, y, h, flag, inMode] = line.split("|").map((v) => Number(v));
  if (![x, y, h].every(Number.isFinite))
    return null;
  return { x, y, paneHeight: h, visible: flag === 1 && inMode === 0 };
}
function createBunTmuxDriver() {
  return {
    listSessions() {
      try {
        return run(["list-sessions", "-F", "#{session_name}|#{session_created}|#{session_windows}|#{session_attached}"]).trim().split(`
`).filter(Boolean).map((line) => {
          const [name, created, windows, attached] = line.split("|");
          return { name, created, windows: Number(windows) || 1, attached: attached === "1" };
        });
      } catch {
        return [];
      }
    },
    async capturePane(session, opts) {
      const args = ["capture-pane", "-t", session, "-p", "-e"];
      if (!opts.currentPaneOnly && typeof opts.startLine === "number") {
        args.push("-S", String(opts.startLine));
      }
      const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      if (await p.exited !== 0)
        throw new Error(`capture-pane failed for ${session}`);
      return out;
    },
    sendKeys(session, data) {
      const bytes = new TextEncoder().encode(data);
      if (bytes.byteLength <= LARGE_INPUT_THRESHOLD_BYTES && !data.includes("\x00")) {
        run(["send-keys", "-t", session, "-l", "--", data]);
        return;
      }
      sendLargeInput(session, bytes);
    },
    getSessionActivity() {
      const map = new Map;
      try {
        for (const line of run(["list-windows", "-a", "-F", "#{session_name}|#{window_activity}"]).trim().split(`
`)) {
          const [name, at] = line.split("|");
          if (!name)
            continue;
          const t = Number(at) || 0;
          if (t > (map.get(name) ?? 0))
            map.set(name, t);
        }
      } catch {}
      return map;
    },
    getHistoryLimit() {
      try {
        const m = run(["show-options", "-g", "history-limit"]).match(/(\d+)/);
        return m ? Number(m[1]) : 2000;
      } catch {
        return 2000;
      }
    },
    setSessionHistoryLimit(session, limit) {
      run(["set-option", "-t", session, "history-limit", String(limit)]);
    },
    resizeWindow(session, cols, rows) {
      run(["resize-window", "-t", session, "-x", String(cols), "-y", String(rows)]);
    },
    hash(content) {
      return Bun.hash(content).toString(36);
    },
    async getCursor(session) {
      try {
        const out = run([
          "display-message",
          "-t",
          session,
          "-p",
          "#{cursor_x}|#{cursor_y}|#{pane_height}|#{cursor_flag}|#{pane_in_mode}"
        ]).trim();
        return parseCursorLine(out);
      } catch {
        return null;
      }
    },
    async captureWithCursor(session, opts) {
      const args = [
        "display-message",
        "-t",
        session,
        "-p",
        "#{cursor_x}|#{cursor_y}|#{pane_height}|#{cursor_flag}|#{pane_in_mode}",
        ";",
        "capture-pane",
        "-t",
        session,
        "-p",
        "-e"
      ];
      if (!opts.currentPaneOnly && typeof opts.startLine === "number") {
        args.push("-S", String(opts.startLine));
      }
      const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      if (await p.exited !== 0)
        throw new Error(`capture-pane failed for ${session}`);
      const nl = out.indexOf(`
`);
      const cursorLine = nl === -1 ? out : out.slice(0, nl);
      const content = nl === -1 ? "" : out.slice(nl + 1);
      const lines = content.replace(/\n$/, "").split(`
`);
      let last = lines.length;
      while (last > 0 && (lines[last - 1] ?? "").trim() === "")
        last--;
      return { content, cursor: parseCursorLine(cursorLine.trim()), trailingBlanks: lines.length - last };
    }
  };
}
function spawnTmuxSession(name, cwd, command) {
  run(["new-session", "-d", "-s", name, "-c", cwd]);
  if (command)
    run(["send-keys", "-t", name, "-l", "--", command]);
  if (command)
    run(["send-keys", "-t", name, "Enter"]);
}
function killTmuxSession(name) {
  run(["kill-session", "-t", name]);
}
// src/upload-handler.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeStoredName } from "@thumbmux/core";
function createUploadHandler(opts) {
  const maxFiles = opts.maxFiles ?? 10;
  const maxBytes = opts.maxBytesPerFile ?? 200 * 1024 * 1024;
  return async function handleUpload(req) {
    const form = await req.formData().catch(() => null);
    if (!form)
      return Response.json({ error: "expected multipart form-data" }, { status: 400 });
    const entries = form.getAll("files");
    const files = entries.filter((f) => typeof f !== "string" && typeof f?.arrayBuffer === "function");
    if (files.length === 0)
      return Response.json({ error: "no files" }, { status: 400 });
    if (files.length > maxFiles)
      return Response.json({ error: `max ${maxFiles} files` }, { status: 413 });
    await mkdir(opts.dir, { recursive: true });
    const stored = [];
    for (const f of files) {
      if (f.size > maxBytes)
        return Response.json({ error: `"${f.name}" exceeds ${maxBytes} bytes` }, { status: 413 });
      const name = makeStoredName(f.name, Date.now(), Math.random().toString(36).slice(2, 8));
      await writeFile(join(opts.dir, name), new Uint8Array(await f.arrayBuffer()));
      stored.push({ original: f.name, stored: name });
    }
    return Response.json({ ok: true, files: stored }, { status: 201 });
  };
}
// src/prefs-handler.ts
import { mergePrefs } from "@thumbmux/core";
import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
var MAX_BYTES = 256 * 1024;
function createPrefsHandler(opts) {
  const { file } = opts;
  let seq = 0;
  let chain = Promise.resolve();
  function serialized(fn) {
    const p = chain.then(fn, fn);
    chain = p.then(() => {}, () => {});
    return p;
  }
  async function read() {
    try {
      const data = await Bun.file(file).json();
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }
  return async function handlePrefs(req) {
    if (req.method === "GET") {
      return Response.json(await read());
    }
    if (req.method === "PUT" || req.method === "POST") {
      const body = await req.text();
      if (body.length > MAX_BYTES) {
        return Response.json({ error: "prefs too large" }, { status: 413 });
      }
      let patch;
      try {
        patch = JSON.parse(body);
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return Response.json({ error: "prefs patch must be a JSON object" }, { status: 400 });
      }
      const next = await serialized(async () => {
        const merged = mergePrefs(await read(), patch);
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}-${++seq}`;
        await Bun.write(tmp, JSON.stringify(merged, null, 2) + `
`);
        renameSync(tmp, file);
        return merged;
      });
      return Response.json(next);
    }
    return Response.json({ error: "method not allowed" }, { status: 405 });
  };
}
// src/frame-journal.ts
import { appendFile, mkdir as mkdir2, readdir, readFile, stat, truncate, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname as dirname2, join as join2, resolve } from "node:path";
import {
  applyMuxDelta,
  chooseMuxOutputFrame as chooseMuxOutputFrame2,
  splitMuxOutputData as splitMuxOutputData2,
  shouldUseMuxDelta
} from "@thumbmux/core";
var DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
var DEFAULT_MAX_ROOT_BYTES = 256 * 1024 * 1024;
var DEFAULT_CHECKPOINT_CADENCE = 64;
var DEFAULT_MAX_PENDING_WRITES = 128;
var DEFAULT_ROOT = resolve(process.cwd(), "thumbmux-frame-journal");
var NODE_STORAGE = {
  ensureDirectory: async (path) => {
    await mkdir2(path, { recursive: true });
  },
  readText: async (path) => readFile(path, "utf8"),
  appendText: async (path, source) => {
    await appendFile(path, source, "utf8");
  },
  truncate: async (path, byteLength) => {
    await truncate(path, byteLength);
  },
  listNames: async (dir) => readdir(dir),
  byteLength: async (path) => (await stat(path)).size,
  remove: async (path) => {
    await unlink(path);
  }
};

class FrameJournal {
  static DEFAULT_MAX_BYTES = DEFAULT_MAX_BYTES;
  static DEFAULT_MAX_ROOT_BYTES = DEFAULT_MAX_ROOT_BYTES;
  rootDir;
  clock;
  checkpointCadence;
  maxBytes;
  maxRootBytes;
  maxPendingWrites;
  onError;
  storage;
  rootReady;
  sessions = new Map;
  stopped = false;
  rootBytes = 0;
  rootBytesKnown = false;
  rootReservedBytes = 0;
  constructor(options = {}) {
    this.rootDir = resolve(options.rootDir ?? DEFAULT_ROOT);
    this.clock = options.clock ?? (() => Date.now());
    this.checkpointCadence = options.checkpointCadence ?? DEFAULT_CHECKPOINT_CADENCE;
    if (!Number.isFinite(this.checkpointCadence) || !Number.isInteger(this.checkpointCadence) || this.checkpointCadence <= 0) {
      throw new Error("checkpointCadence must be a positive integer.");
    }
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (this.maxBytes !== Infinity && (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0)) {
      throw new Error("maxBytes must be a finite positive number or Infinity.");
    }
    this.maxRootBytes = options.maxRootBytes ?? DEFAULT_MAX_ROOT_BYTES;
    if (this.maxRootBytes !== Infinity && (!Number.isFinite(this.maxRootBytes) || this.maxRootBytes <= 0)) {
      throw new Error("maxRootBytes must be a finite positive number or Infinity.");
    }
    this.maxPendingWrites = options.maxPendingWrites ?? DEFAULT_MAX_PENDING_WRITES;
    if (this.maxPendingWrites !== Infinity && (!Number.isFinite(this.maxPendingWrites) || !Number.isInteger(this.maxPendingWrites) || this.maxPendingWrites <= 0)) {
      throw new Error("maxPendingWrites must be a positive integer or Infinity.");
    }
    this.onError = options.onError ?? (() => {
      return;
    });
    this.storage = options.storage ?? NODE_STORAGE;
    this.rootReady = this.storage.ensureDirectory(this.rootDir).then(() => this.scanRootBytes());
  }
  startSession(session) {
    const state = this.getOrCreateState(session);
    if (!state.recoveryFailed)
      state.accepting = true;
    return this.snapshotState(state);
  }
  async recoverSession(session) {
    const state = this.getOrCreateState(session);
    const recovery = state.queue.then(async () => {
      await this.rootReady;
      let source = "";
      try {
        source = await this.storage.readText(state.path);
      } catch (cause) {
        if (!isFileNotFound(cause))
          throw cause;
        state.base = null;
        state.deltasSinceCheckpoint = 0;
        state.lastAt = null;
        state.recordCount = 0;
        state.recoveryFailed = false;
        state.bytes = 0;
        state.bytesKnown = true;
        state.accepting = !state.stopRequested;
        return this.snapshotState(state);
      }
      const prefix = completePrefixInfo(source);
      const priorFileBytes = Buffer.byteLength(source, "utf8");
      if (priorFileBytes > prefix.byteLength) {
        if (!this.storage.truncate) {
          throw new Error("Journal has a crash-torn trailing line and storage.truncate is unavailable; refusing to accept writes.");
        }
        await this.storage.truncate(state.path, prefix.byteLength);
        this.adjustRootBytes(prefix.byteLength - priorFileBytes);
        source = source.slice(0, prefix.charLength);
      }
      state.bytes = prefix.byteLength;
      state.bytesKnown = true;
      const recovered = parseAndValidateJournal(source, session, this.checkpointCadence);
      state.base = recovered.base;
      state.deltasSinceCheckpoint = recovered.deltasSinceCheckpoint;
      state.lastAt = recovered.lastAt;
      state.recordCount = recovered.recordCount;
      state.recoveryFailed = false;
      state.accepting = !state.stopRequested;
      return this.snapshotState(state);
    });
    state.queue = recovery.then(() => {
      return;
    }, (cause) => {
      state.base = null;
      state.deltasSinceCheckpoint = 0;
      state.lastAt = null;
      state.recordCount = 0;
      state.recoveryFailed = true;
      state.accepting = false;
      this.reportError({ session, path: state.path, phase: "recover", cause });
    });
    return recovery;
  }
  getSessionPath(session) {
    return this.makeSessionPath(session);
  }
  get sessionCount() {
    return this.sessions.size;
  }
  get rootByteCount() {
    return this.rootBytes;
  }
  capture(session, frame, at) {
    if (this.stopped)
      return false;
    const state = this.getOrCreateState(session);
    if (state.stopRequested || !state.accepting || state.recoveryFailed)
      return false;
    const fullFrame = normalizeFullFrame(session, frame);
    const recordAt = at ?? this.clock();
    if (!Number.isFinite(recordAt)) {
      throw new Error("Frame journal capture timestamp must be finite.");
    }
    if (state.pending >= this.maxPendingWrites) {
      this.reportError({
        session,
        path: state.path,
        phase: "drop",
        at: recordAt,
        cause: new Error("maxPendingWrites exceeded; capture dropped.")
      });
      return false;
    }
    let estimate = 0;
    const capsEnabled = this.maxBytes !== Infinity || this.maxRootBytes !== Infinity;
    if (capsEnabled) {
      estimate = Buffer.byteLength(JSON.stringify({ v: 1, session, at: recordAt, frame: fullFrame }), "utf8") + 33;
      if (this.maxBytes !== Infinity) {
        if (state.bytes + state.reservedBytes + estimate > this.maxBytes) {
          this.refuseSessionLimit(state, recordAt, "maxBytes exceeded; session recording stopped.");
          return false;
        }
      }
      if (this.maxRootBytes !== Infinity) {
        if (this.rootBytes + this.rootReservedBytes + estimate > this.maxRootBytes) {
          this.reportRootLimit(state, recordAt);
          return false;
        }
      }
      if (this.maxBytes !== Infinity)
        state.reservedBytes += estimate;
      if (this.maxRootBytes !== Infinity)
        this.rootReservedBytes += estimate;
    }
    state.pending += 1;
    state.queue = state.queue.then(async () => {
      try {
        if (state.recoveryFailed)
          return;
        await this.persistCapture(state, fullFrame, recordAt);
      } finally {
        state.pending -= 1;
        if (this.maxBytes !== Infinity)
          state.reservedBytes -= estimate;
        if (this.maxRootBytes !== Infinity)
          this.rootReservedBytes -= estimate;
      }
    }).catch((cause) => {
      state.base = null;
      state.deltasSinceCheckpoint = 0;
      this.reportError({
        session,
        path: state.path,
        phase: "write",
        at: recordAt,
        cause
      });
    });
    return true;
  }
  async flushSession(session) {
    const state = this.sessions.get(session);
    if (!state)
      return;
    await state.queue;
  }
  async flushAll() {
    const flushes = Array.from(this.sessions.values()).map((state) => state.queue);
    await Promise.all(flushes);
  }
  async stopSession(session) {
    const state = this.sessions.get(session);
    if (!state)
      return;
    state.stopRequested = true;
    state.accepting = false;
    await state.queue;
    state.accepting = false;
  }
  async closeSession(session) {
    const state = this.sessions.get(session);
    if (!state)
      return;
    state.stopRequested = true;
    state.accepting = false;
    await state.queue;
    this.sessions.delete(session);
  }
  async deleteSessionJournal(session) {
    await this.rootReady;
    const path = this.makeSessionPath(session);
    const existing = this.sessions.get(session);
    let knownBytes = null;
    if (existing) {
      existing.stopRequested = true;
      existing.accepting = false;
      await existing.queue;
      if (existing.bytesKnown)
        knownBytes = existing.bytes;
      this.sessions.delete(session);
    }
    if (!this.storage.remove) {
      throw new Error("storage.remove is unavailable; cannot delete session journal.");
    }
    let removedBytes = knownBytes;
    if (removedBytes === null) {
      removedBytes = await this.measureFileBytes(path);
    }
    try {
      await this.storage.remove(path);
    } catch (cause) {
      if (!isFileNotFound(cause))
        throw cause;
      return false;
    }
    if (removedBytes > 0) {
      this.adjustRootBytes(-removedBytes);
    }
    return true;
  }
  async stop() {
    this.stopped = true;
    for (const state of this.sessions.values()) {
      state.stopRequested = true;
      state.accepting = false;
    }
    await this.flushAll();
    this.sessions.clear();
  }
  getOrCreateState(session) {
    const existing = this.sessions.get(session);
    if (existing)
      return existing;
    const path = this.makeSessionPath(session);
    const state = {
      session,
      path,
      base: null,
      deltasSinceCheckpoint: 0,
      lastAt: null,
      recordCount: 0,
      accepting: true,
      recoveryFailed: false,
      queue: Promise.resolve(),
      bytes: 0,
      bytesKnown: false,
      reservedBytes: 0,
      pending: 0,
      stopRequested: false,
      limitReported: false
    };
    this.sessions.set(session, state);
    return state;
  }
  snapshotState(state) {
    return {
      session: state.session,
      path: state.path,
      base: state.base ? state.base.slice() : [],
      recordCount: state.recordCount,
      lastAt: state.lastAt,
      deltasSinceCheckpoint: state.deltasSinceCheckpoint
    };
  }
  makeSessionPath(session) {
    const digest = hashSession(session);
    return join2(this.rootDir, `${digest}.ndjson`);
  }
  reportError(report) {
    try {
      this.onError(report);
    } catch {}
  }
  refuseSessionLimit(state, at, message) {
    state.accepting = false;
    if (!state.limitReported) {
      state.limitReported = true;
      this.reportError({
        session: state.session,
        path: state.path,
        phase: "limit",
        at,
        cause: new Error(message)
      });
    }
  }
  reportRootLimit(state, at) {
    if (!state.limitReported) {
      state.limitReported = true;
      this.reportError({
        session: state.session,
        path: state.path,
        phase: "limit",
        at,
        cause: new Error("maxRootBytes exceeded; capture refused.")
      });
    }
  }
  adjustRootBytes(delta) {
    this.rootBytes = Math.max(0, this.rootBytes + delta);
  }
  async scanRootBytes() {
    if (!this.storage.listNames) {
      this.rootBytes = 0;
      this.rootBytesKnown = true;
      return;
    }
    let names;
    try {
      names = await this.storage.listNames(this.rootDir);
    } catch {
      this.rootBytes = 0;
      this.rootBytesKnown = true;
      return;
    }
    let total = 0;
    for (const name of names) {
      if (!name.endsWith(".ndjson"))
        continue;
      const path = join2(this.rootDir, name);
      total += await this.measureFileBytes(path);
    }
    this.rootBytes = total;
    this.rootBytesKnown = true;
  }
  async measureFileBytes(path) {
    if (this.storage.byteLength) {
      try {
        return await this.storage.byteLength(path);
      } catch (cause) {
        if (isFileNotFound(cause))
          return 0;
        throw cause;
      }
    }
    try {
      const text = await this.storage.readText(path);
      return Buffer.byteLength(text, "utf8");
    } catch (cause) {
      if (isFileNotFound(cause))
        return 0;
      throw cause;
    }
  }
  async ensureBytesKnown(state) {
    let source;
    try {
      source = await this.storage.readText(state.path);
    } catch (cause) {
      if (isFileNotFound(cause)) {
        state.bytes = 0;
        state.bytesKnown = true;
        return;
      }
      throw cause;
    }
    const prefix = completePrefixInfo(source);
    const priorFileBytes = Buffer.byteLength(source, "utf8");
    state.bytes = prefix.byteLength;
    state.bytesKnown = true;
    if (priorFileBytes > prefix.byteLength) {
      if (!this.storage.truncate) {
        state.accepting = false;
        state.recoveryFailed = true;
        throw new Error("Journal has a crash-torn trailing line and storage.truncate is unavailable; refusing to append.");
      }
      await this.storage.truncate(state.path, prefix.byteLength);
      this.adjustRootBytes(prefix.byteLength - priorFileBytes);
    }
  }
  async persistCapture(state, fullFrame, at) {
    await this.rootReady;
    if (!state.bytesKnown) {
      await this.ensureBytesKnown(state);
    }
    const recordAt = state.lastAt === null ? at : Math.max(state.lastAt, at);
    const base = state.base;
    let frame;
    if (base === null || fullFrame.reset !== undefined || state.deltasSinceCheckpoint >= this.checkpointCadence) {
      frame = fullFrame;
    } else {
      frame = chooseMuxOutputFrame2(fullFrame, base);
    }
    const record = {
      v: 1,
      session: state.session,
      at: recordAt,
      frame
    };
    let nextBase;
    let nextDeltaCount = state.deltasSinceCheckpoint;
    if (frame.type === "delta") {
      if (!shouldUseMuxDelta(fullFrame, frame) || base === null) {
        nextBase = splitMuxOutputData2(fullFrame.data);
        nextDeltaCount = 0;
      } else {
        const next = applyMuxDelta(base, frame);
        if (!next) {
          throw new Error("Unable to apply delta for persistent journal write.");
        }
        nextBase = next;
        nextDeltaCount = state.deltasSinceCheckpoint + 1;
      }
    } else {
      nextBase = splitMuxOutputData2(frame.data);
      nextDeltaCount = 0;
    }
    const line = `${JSON.stringify(record)}
`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (this.maxBytes !== Infinity && state.bytes + lineBytes > this.maxBytes) {
      this.refuseSessionLimit(state, recordAt, "maxBytes exceeded; session recording stopped.");
      return;
    }
    if (this.maxRootBytes !== Infinity && this.rootBytes + lineBytes > this.maxRootBytes) {
      this.reportRootLimit(state, recordAt);
      return;
    }
    await this.storage.ensureDirectory(dirname2(state.path));
    try {
      await this.storage.appendText(state.path, line);
    } catch (cause) {
      let rolledBack = false;
      if (state.bytesKnown && this.storage.truncate) {
        try {
          await this.storage.truncate(state.path, state.bytes);
          rolledBack = true;
        } catch {
          rolledBack = false;
        }
      }
      if (!rolledBack) {
        state.recoveryFailed = true;
        state.accepting = false;
      }
      throw cause;
    }
    state.bytes += lineBytes;
    this.adjustRootBytes(lineBytes);
    state.base = nextBase;
    state.deltasSinceCheckpoint = nextDeltaCount;
    state.lastAt = recordAt;
    state.recordCount += 1;
  }
}
function completePrefixInfo(source) {
  const lastNewline = source.lastIndexOf(`
`);
  if (lastNewline === -1) {
    return { charLength: 0, byteLength: 0 };
  }
  const charLength = lastNewline + 1;
  return {
    charLength,
    byteLength: Buffer.byteLength(source.slice(0, charLength), "utf8")
  };
}
function hashSession(session) {
  if (typeof session !== "string")
    throw new Error("Frame journal session must be a string.");
  return createHash("sha256").update(session, "utf8").digest("hex");
}
function isFileNotFound(cause) {
  return Boolean(cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT");
}
function normalizeFullFrame(session, frame) {
  if (frame.type !== "output") {
    throw new Error("Frame journal only accepts output frames as captures.");
  }
  if (frame.channel !== session) {
    throw new Error("Frame journal capture channel must equal its session.");
  }
  if (typeof frame.data !== "string") {
    throw new Error("Frame journal capture data must be a string.");
  }
  const canonical = {
    channel: session,
    type: "output",
    data: frame.data
  };
  if (Object.prototype.hasOwnProperty.call(frame, "cursor")) {
    const cursor = frame.cursor;
    if (cursor === undefined) {} else if (cursor === null) {
      canonical.cursor = null;
    } else if (isFiniteIntegerCursor(cursor)) {
      canonical.cursor = { row: cursor.row, col: cursor.col };
    } else {
      throw new Error("Frame journal capture cursor must be {row:number,col:number} or null.");
    }
  }
  if (Object.prototype.hasOwnProperty.call(frame, "reset")) {
    const reset = frame.reset;
    if (reset !== "resize" && reset !== "resync") {
      throw new Error('Frame journal capture reset must be "resize" or "resync".');
    }
    canonical.reset = reset;
  }
  return canonical;
}
function isFiniteIntegerCursor(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const cursor = value;
  if (Object.keys(cursor).length !== 2 || !Object.prototype.hasOwnProperty.call(cursor, "row") || !Object.prototype.hasOwnProperty.call(cursor, "col")) {
    return false;
  }
  return Number.isInteger(cursor.row) && Number.isInteger(cursor.col);
}
function parseAndValidateJournal(source, expectedSession, checkpointCadence) {
  const lines = splitCompleteNdjsonLines(source);
  if (lines.length === 0) {
    return { base: [], lastAt: null, recordCount: 0, deltasSinceCheckpoint: 0 };
  }
  let currentBase = null;
  let deltaCount = 0;
  let previousAt = Number.NEGATIVE_INFINITY;
  let recordCount = 0;
  let lastAt = null;
  for (let i = 0;i < lines.length; i += 1) {
    const rawLine = lines[i];
    const lineNo = i + 1;
    if (rawLine.length === 0) {
      throw new Error(`Malformed blank line at NDJSON line ${lineNo}.`);
    }
    const record = parseJournalRecord(rawLine, lineNo);
    if (record.session !== expectedSession) {
      throw new Error(`Session mismatch at NDJSON line ${lineNo}: expected "${expectedSession}" but got "${record.session}".`);
    }
    if (!Number.isFinite(record.at)) {
      throw new Error(`Invalid at timestamp at NDJSON line ${lineNo}: must be finite.`);
    }
    if (record.at < previousAt) {
      throw new Error(`Out-of-order timestamp at NDJSON line ${lineNo}: ${record.at} < ${previousAt}.`);
    }
    if (record.frame.channel !== record.session) {
      throw new Error(`Session/channel mismatch at NDJSON line ${lineNo}: record.session="${record.session}" but frame.channel="${record.frame.channel}".`);
    }
    if (recordCount === 0 && record.frame.type === "delta") {
      throw new Error(`Invalid first record at NDJSON line ${lineNo}: journal must start with a full frame.`);
    }
    if (record.frame.type === "output") {
      currentBase = splitMuxOutputData2(record.frame.data);
      deltaCount = 0;
    } else {
      if (currentBase === null) {
        throw new Error(`Invalid delta at NDJSON line ${lineNo}: no prior full frame available.`);
      }
      const next = applyMuxDelta(currentBase, record.frame);
      if (!next) {
        throw new Error(`Invalid delta at NDJSON line ${lineNo}: apply failed against current base.`);
      }
      const candidate = {
        channel: expectedSession,
        type: "output",
        data: next.join(`
`)
      };
      if (Object.prototype.hasOwnProperty.call(record.frame, "cursor")) {
        candidate.cursor = record.frame.cursor;
      }
      if (!shouldUseMuxDelta(candidate, record.frame)) {
        throw new Error(`Invalid delta at NDJSON line ${lineNo}: candidate delta is not eligible under strict protocol semantics.`);
      }
      currentBase = next;
      deltaCount += 1;
      if (deltaCount > checkpointCadence) {
        throw new Error(`Checkpoint cadence exceeded at NDJSON line ${lineNo}: more than ${checkpointCadence} deltas follow one full frame.`);
      }
    }
    recordCount += 1;
    previousAt = record.at;
    lastAt = record.at;
  }
  return {
    base: currentBase ?? [],
    lastAt,
    recordCount,
    deltasSinceCheckpoint: deltaCount
  };
}
function splitCompleteNdjsonLines(source) {
  const lines = [];
  let start = 0;
  while (true) {
    const newline = source.indexOf(`
`, start);
    if (newline === -1)
      break;
    lines.push(source.slice(start, newline));
    start = newline + 1;
  }
  return lines;
}
function parseJournalRecord(rawLine, lineNo) {
  let parsed;
  try {
    parsed = JSON.parse(rawLine);
  } catch (cause) {
    throw new Error(`Malformed JSON at NDJSON line ${lineNo}: ${cause instanceof Error ? cause.message : "invalid JSON."}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid record at NDJSON line ${lineNo}: must be an object.`);
  }
  const record = parsed;
  const keys = Object.keys(record);
  const expected = ["v", "session", "at", "frame"];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error(`Invalid record shape at NDJSON line ${lineNo}: must contain exactly v, session, at, frame.`);
  }
  if (record.v !== 1) {
    throw new Error(`Invalid journal version at NDJSON line ${lineNo}: expected 1.`);
  }
  if (typeof record.session !== "string") {
    throw new Error(`Invalid session at NDJSON line ${lineNo}: expected a string session.`);
  }
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) {
    throw new Error(`Invalid at at NDJSON line ${lineNo}: expected a finite number.`);
  }
  const frame = parseFrame(record.frame, lineNo, record.session);
  return {
    v: 1,
    session: record.session,
    at: record.at,
    frame
  };
}
function parseFrame(value, lineNo, session) {
  if (value === null || typeof value !== "object") {
    throw new Error(`Invalid frame at NDJSON line ${lineNo}: must be an object.`);
  }
  const frame = value;
  const type = frame.type;
  if (type === "output") {
    return parseFullFrame(frame, lineNo, session);
  }
  if (type === "delta") {
    return parseDeltaFrame(frame, lineNo, session);
  }
  throw new Error(`Invalid frame at NDJSON line ${lineNo}: unsupported frame type "${String(type)}".`);
}
function parseFullFrame(frame, lineNo, session) {
  const keys = Object.keys(frame);
  const allowed = new Set(["channel", "type", "data", "cursor", "reset"]);
  const required = ["channel", "type", "data"];
  if (keys.some((key) => !allowed.has(key))) {
    throw new Error(`Invalid full frame keys at NDJSON line ${lineNo}: unexpected property "${keys.find((key) => !allowed.has(key))}".`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(frame, key)) {
      throw new Error(`Invalid full frame at NDJSON line ${lineNo}: missing "${key}".`);
    }
  }
  if (typeof frame.channel !== "string" || frame.channel !== session) {
    throw new Error(`Invalid full frame at NDJSON line ${lineNo}: channel must equal record.session.`);
  }
  if (frame.type !== "output" || typeof frame.type !== "string") {
    throw new Error(`Invalid full frame at NDJSON line ${lineNo}: expected type "output".`);
  }
  if (typeof frame.data !== "string") {
    throw new Error(`Invalid full frame at NDJSON line ${lineNo}: data must be a string.`);
  }
  if (Object.prototype.hasOwnProperty.call(frame, "reset")) {
    if (frame.reset !== "resize" && frame.reset !== "resync") {
      throw new Error(`Invalid full frame at NDJSON line ${lineNo}: reset must be "resize" or "resync".`);
    }
  }
  const cursor = parseOptionalCursor(frame, lineNo, "full frame");
  const parsed = {
    channel: session,
    type: "output",
    data: frame.data
  };
  if (cursor !== undefined)
    parsed.cursor = cursor;
  if (Object.prototype.hasOwnProperty.call(frame, "reset")) {
    parsed.reset = frame.reset === "resize" || frame.reset === "resync" ? frame.reset : undefined;
  }
  return parsed;
}
function parseDeltaFrame(frame, lineNo, session) {
  const keys = Object.keys(frame);
  const allowed = new Set(["channel", "type", "baseLength", "prefix", "prefixHash", "lines", "cursor"]);
  const required = ["channel", "type", "baseLength", "prefix", "prefixHash", "lines"];
  if (keys.some((key) => !allowed.has(key))) {
    throw new Error(`Invalid delta frame keys at NDJSON line ${lineNo}: unexpected property "${keys.find((key) => !allowed.has(key))}".`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(frame, key)) {
      throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: missing "${key}".`);
    }
  }
  if (typeof frame.channel !== "string" || frame.channel !== session) {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: channel must equal record.session.`);
  }
  if (frame.type !== "delta" || typeof frame.type !== "string") {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: expected type "delta".`);
  }
  if (typeof frame.baseLength !== "number" || !Number.isInteger(frame.baseLength) || frame.baseLength < 0) {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: baseLength must be a non-negative integer.`);
  }
  if (typeof frame.prefix !== "number" || !Number.isInteger(frame.prefix) || frame.prefix < 0) {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: prefix must be a non-negative integer.`);
  }
  if (typeof frame.prefixHash !== "string") {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: prefixHash must be a string.`);
  }
  if (!Array.isArray(frame.lines) || !frame.lines.every((line) => typeof line === "string")) {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: lines must be string[].`);
  }
  const cursor = parseOptionalCursor(frame, lineNo, "delta frame");
  if (frame.baseLength < 0 || frame.prefix > frame.baseLength) {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: prefix must be <= baseLength.`);
  }
  return {
    channel: frame.channel,
    type: "delta",
    baseLength: frame.baseLength,
    prefix: frame.prefix,
    prefixHash: frame.prefixHash,
    lines: frame.lines.slice(),
    ...Object.prototype.hasOwnProperty.call(frame, "cursor") ? { cursor } : {}
  };
}
function parseOptionalCursor(frame, lineNo, frameKind) {
  if (!Object.prototype.hasOwnProperty.call(frame, "cursor"))
    return;
  const value = frame.cursor;
  if (value === null)
    return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${frameKind} at NDJSON line ${lineNo}: cursor must be {row:number,col:number} or null.`);
  }
  const cursor = value;
  if (Object.keys(cursor).length !== 2 || !Number.isInteger(cursor.row) || !Number.isInteger(cursor.col)) {
    throw new Error(`Invalid ${frameKind} at NDJSON line ${lineNo}: cursor must be {row:number,col:number} or null.`);
  }
  return {
    row: cursor.row,
    col: cursor.col
  };
}
// src/token-guard.ts
import { createHash as createHash2, timingSafeEqual } from "node:crypto";
var ERROR_TEXT = {
  missing_credential: "authentication required",
  malformed_credential: "malformed credential",
  invalid_credential: "invalid credential",
  expired_credential: "credential expired",
  forbidden_scope: "insufficient scope",
  forbidden_session: "session denied",
  forbidden_operation: "operation denied"
};
var DEFAULT_COOKIE_NAME = "tmux_demo_t";
var DEFAULT_QUERY_PARAM = "t";
var DEFAULT_QUERY_COOKIE_SAFE = "<redacted>";
var SAFE_COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function safeDecode(value, plusAsSpace = true) {
  try {
    const normalized = plusAsSpace ? value.replace(/\+/g, "%20") : value;
    const decoded = decodeURIComponent(normalized);
    return decoded.includes("\r") || decoded.includes(`
`) ? null : decoded;
  } catch {
    return null;
  }
}
function parseQueryPairs(search) {
  if (!search)
    return [];
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (!query)
    return [];
  const segments = query.split("&");
  const pairs = [];
  for (const segment of segments) {
    if (!segment)
      return null;
    const eq = segment.indexOf("=");
    if (eq < 0)
      return null;
    const rawName = segment.slice(0, eq);
    const rawValue = segment.slice(eq + 1);
    const name = safeDecode(rawName);
    const value = safeDecode(rawValue);
    if (name === null || value === null)
      return null;
    if (!name)
      return null;
    pairs.push({ name, value });
  }
  return pairs;
}
function parseSingleQueryValue(search, expected) {
  const parsed = parseQueryPairs(search);
  if (parsed === null)
    return { malformed: true };
  const matches = parsed.filter((entry) => entry.name === expected);
  if (matches.length === 0)
    return { malformed: false };
  if (matches.length !== 1)
    return { malformed: true };
  return { value: matches[0].value, malformed: false };
}
function extractQueryCredential(search, tokenParam) {
  if (!search)
    return { kind: "absent" };
  const query = search.startsWith("?") ? search.slice(1) : search;
  const segments = query.split("&");
  let hasQueryToken = false;
  let tokenValue;
  let tokenCount = 0;
  let malformed = false;
  for (const segment of segments) {
    if (!segment) {
      malformed = true;
      continue;
    }
    const eq = segment.indexOf("=");
    if (eq < 0) {
      const rawName2 = segment;
      const name2 = safeDecode(rawName2);
      if (name2 === null) {
        malformed = true;
        continue;
      }
      if (name2 === tokenParam)
        return { kind: "invalid" };
      continue;
    }
    const rawName = segment.slice(0, eq);
    const rawValue = segment.slice(eq + 1);
    const name = safeDecode(rawName);
    const value = safeDecode(rawValue);
    if (name === null || value === null || !name) {
      malformed = true;
      continue;
    }
    if (name === tokenParam) {
      hasQueryToken = true;
      tokenCount += 1;
      tokenValue = value;
    }
  }
  if (!hasQueryToken)
    return { kind: "absent" };
  if (malformed)
    return { kind: "invalid" };
  if (tokenCount !== 1 || tokenValue === "")
    return { kind: "invalid" };
  return { kind: "valid", value: tokenValue ?? "" };
}
function parseCookieHeader(header, cookieName) {
  if (!header)
    return { kind: "absent" };
  const segments = header.split(";");
  let matches = 0;
  let tokenValue = null;
  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (!segment)
      return { kind: "invalid" };
    const eq = segment.indexOf("=");
    if (eq <= 0)
      return { kind: "invalid" };
    const rawName = segment.slice(0, eq);
    const rawValue = segment.slice(eq + 1);
    if (rawName !== cookieName)
      continue;
    const value = safeDecode(rawValue, false);
    if (value === null)
      return { kind: "invalid" };
    if (matches >= 1)
      return { kind: "invalid" };
    tokenValue = value;
    matches += 1;
  }
  if (matches === 0)
    return { kind: "absent" };
  return { kind: "valid", value: tokenValue };
}
function sessionsEqual(a, b) {
  if (a === b)
    return true;
  if (a === undefined || b === undefined)
    return false;
  if (a.length !== b.length)
    return false;
  for (let i = 0;i < a.length; i++) {
    if (a[i] !== b[i])
      return false;
  }
  return true;
}
function principalMatchesGrant(principal, grant) {
  return principal.scope === grant.scope && principal.expiresAt === grant.expiresAt && sessionsEqual(principal.sessions, grant.sessions);
}
function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
function isInteger(value) {
  return typeof value === "number" && Number.isInteger(value);
}
function isNonEmptySession(value) {
  return typeof value === "string" && value.length > 0;
}
function extractSession(row) {
  if (typeof row === "string")
    return row;
  if (typeof row !== "object" || row === null)
    return null;
  const candidate = row;
  return typeof candidate.name === "string" ? candidate.name : null;
}
function isTokenScope(value) {
  return value === "read" || value === "interactive";
}
function hasValidSessions(value) {
  return value === undefined || Array.isArray(value) && value.every((session) => typeof session === "string" && session.length > 0);
}
function isValidGrant(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const grant = value;
  return typeof grant.token === "string" && grant.token.length > 0 && !/[\r\n]/.test(grant.token) && isTokenScope(grant.scope) && Number.isFinite(grant.expiresAt) && hasValidSessions(grant.sessions);
}
function isValidPrincipal(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const principal = value;
  return isTokenScope(principal.scope) && Number.isFinite(principal.expiresAt) && hasValidSessions(principal.sessions);
}
function tokenDigest(token) {
  return createHash2("sha256").update(token, "utf8").digest();
}
function createTokenGuard(options) {
  const grants = options.grants ?? [];
  const queryParamName = options.queryParamName || DEFAULT_QUERY_PARAM;
  const cookieName = options.cookieName || DEFAULT_COOKIE_NAME;
  const now = options.now ?? Date.now;
  const redactionPlaceholder = options.redactionPlaceholder ?? DEFAULT_QUERY_COOKIE_SAFE;
  if (!SAFE_COOKIE_NAME.test(cookieName) || !queryParamName || /[\r\n]/.test(queryParamName)) {
    throw new Error("token guard: invalid cookieName");
  }
  if (!Array.isArray(grants) || grants.some((grant) => !isValidGrant(grant))) {
    throw new Error("token guard: invalid grant configuration");
  }
  const configuredTokens = new Set(grants.map((grant) => grant.token));
  if (configuredTokens.size !== grants.length) {
    throw new Error("token guard: duplicate grant configuration");
  }
  const revokedState = new WeakMap;
  const snapshots = [];
  for (const grant of grants) {
    const token = grant.token;
    const scope = grant.scope;
    const expiresAt = grant.expiresAt;
    const sessions = grant.sessions;
    const snapshot = {
      token,
      scope,
      expiresAt,
      sessions: sessions === undefined ? undefined : Object.freeze([...sessions]),
      digest: tokenDigest(token),
      get revoked() {
        return revokedState.get(this) ?? false;
      },
      set revoked(value) {
        revokedState.set(this, value);
      }
    };
    Object.freeze(snapshot);
    snapshots.push(snapshot);
  }
  const redactionTokens = snapshots.map((s) => s.token);
  const issuedPrincipals = new WeakMap;
  const shouldUseSecureCookie = (request) => {
    if (options.cookieSecure === undefined) {
      const xfp = request.headers.get("x-forwarded-proto");
      if (xfp && /\bhttps\b/i.test(xfp.split(",")[0]?.trim() ?? ""))
        return true;
      const protocol = new URL(request.url).protocol;
      return protocol === "https:";
    }
    if (typeof options.cookieSecure === "boolean")
      return options.cookieSecure;
    return options.cookieSecure(request);
  };
  const isExpiredGrant = (grant) => {
    const currentTime = now();
    return !Number.isFinite(currentTime) || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= currentTime;
  };
  const locateGrant = (token) => {
    const candidate = tokenDigest(token);
    let hit;
    for (const snapshot of snapshots) {
      if (timingSafeEqual(candidate, snapshot.digest)) {
        hit = snapshot;
      }
    }
    return hit;
  };
  const findGrantByToken = (token) => {
    const grant = locateGrant(token);
    if (!grant || grant.revoked)
      return;
    return grant;
  };
  const mintPrincipal = (grant) => {
    const principal = Object.freeze({
      scope: grant.scope,
      expiresAt: grant.expiresAt,
      sessions: grant.sessions
    });
    issuedPrincipals.set(principal, grant);
    return principal;
  };
  const resolveActiveGrant = (principal) => {
    if (!isValidPrincipal(principal))
      return;
    const grant = issuedPrincipals.get(principal);
    if (grant === undefined)
      return;
    if (!principalMatchesGrant(principal, grant))
      return;
    if (grant.revoked)
      return;
    return grant;
  };
  const isSessionAllowed = (principal, session) => {
    if (typeof session !== "string" || session.length === 0)
      return false;
    const grant = resolveActiveGrant(principal);
    if (grant === undefined || isExpiredGrant(grant))
      return false;
    if (grant.sessions === undefined)
      return true;
    if (grant.sessions.length === 0)
      return false;
    return grant.sessions.includes(session);
  };
  const sanitizePrincipal = (principal) => {
    const grant = issuedPrincipals.get(principal);
    if (!isValidPrincipal(principal) || grant === undefined || grant.revoked || !principalMatchesGrant(principal, grant)) {
      throw new Error("token guard: invalid principal");
    }
    return mintPrincipal(grant);
  };
  const createSocketPrincipal = (grant) => {
    const configuredGrant = isValidGrant(grant) ? findGrantByToken(grant.token) : undefined;
    if (!configuredGrant) {
      throw new Error("token guard: invalid configured grant");
    }
    return mintPrincipal(configuredGrant);
  };
  const makeCookieHeader = (grant, req) => {
    const snapshot = isValidGrant(grant) ? findGrantByToken(grant.token) : undefined;
    if (!snapshot) {
      throw new Error("token guard: invalid token value for cookie encoding");
    }
    const encoded = encodeURIComponent(snapshot.token);
    const remainingMs = snapshot.expiresAt - now();
    const maxAgeSeconds = Number.isFinite(remainingMs) ? Math.max(0, Math.floor(remainingMs / 1000)) : 0;
    let cookie = `${cookieName}=${encoded}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
    if (shouldUseSecureCookie(req))
      cookie += "; Secure";
    if (/\r|\n/.test(cookie)) {
      throw new Error("token guard: refused unsafe cookie header generation");
    }
    return cookie;
  };
  const redact = (text) => {
    if (!text)
      return text;
    let output = text;
    const genericQueryCredential = new RegExp(`(^|[?&])${escapeRegex(queryParamName)}=[^&#\\s]*`, "gi");
    const genericCookieCredential = new RegExp(`(^|[;,\\s])(${escapeRegex(cookieName)}\\s*=\\s*)[^;\\s]*`, "gi");
    output = output.replace(genericQueryCredential, `$1${redactionPlaceholder}`);
    output = output.replace(genericCookieCredential, `$1$2${redactionPlaceholder}`);
    for (const token of redactionTokens) {
      const encoded = encodeURIComponent(token);
      output = output.replaceAll(token, redactionPlaceholder);
      output = output.replaceAll(encoded, redactionPlaceholder);
    }
    return output;
  };
  const fail401 = (code) => ({
    ok: false,
    status: 401,
    code,
    message: ERROR_TEXT[code]
  });
  const fail403 = (code) => ({
    ok: false,
    status: 403,
    code,
    message: ERROR_TEXT[code]
  });
  const guardAuthenticateFailure = (request, source, result) => {
    switch (result.kind) {
      case "absent":
        return fail401(source === "query" ? "missing_credential" : "missing_credential");
      case "invalid":
        return fail401(source === "query" ? "malformed_credential" : "malformed_credential");
      case "not-found":
        return fail401(source === "query" ? "invalid_credential" : "invalid_credential");
      case "expired":
        return fail401("expired_credential");
      default:
        return fail401("missing_credential");
    }
  };
  const authenticate = (request) => {
    const token = extractQueryCredential(new URL(request.url).search, queryParamName);
    if (token.kind === "valid") {
      const grant2 = findGrantByToken(token.value);
      if (!grant2)
        return guardAuthenticateFailure(request, "query", { kind: "not-found" });
      if (isExpiredGrant(grant2)) {
        return guardAuthenticateFailure(request, "query", { kind: "expired" });
      }
      return {
        ok: true,
        status: 200,
        source: "query",
        principal: mintPrincipal(grant2),
        setCookie: makeCookieHeader(grant2, request)
      };
    }
    if (token.kind === "invalid") {
      return guardAuthenticateFailure(request, "query", { kind: "invalid" });
    }
    const cookie = parseCookieHeader(request.headers.get("cookie") ?? "", cookieName);
    if (cookie.kind === "absent") {
      return guardAuthenticateFailure(request, "cookie", { kind: "absent" });
    }
    if (cookie.kind === "invalid") {
      return guardAuthenticateFailure(request, "cookie", { kind: "invalid" });
    }
    const grant = findGrantByToken(cookie.value);
    if (!grant) {
      return guardAuthenticateFailure(request, "cookie", { kind: "not-found" });
    }
    if (isExpiredGrant(grant)) {
      return guardAuthenticateFailure(request, "cookie", { kind: "expired" });
    }
    return {
      ok: true,
      status: 200,
      source: "cookie",
      principal: mintPrincipal(grant)
    };
  };
  const ensureActivePrincipal = (principal) => {
    if (!isValidPrincipal(principal))
      return fail401("invalid_credential");
    const grant = issuedPrincipals.get(principal);
    if (grant === undefined || !principalMatchesGrant(principal, grant)) {
      return fail401("invalid_credential");
    }
    if (grant.revoked)
      return fail401("invalid_credential");
    if (isExpiredGrant(grant))
      return fail401("expired_credential");
    return null;
  };
  const revoke = (token) => {
    if (typeof token !== "string" || token.length === 0)
      return false;
    const grant = locateGrant(token);
    if (!grant || grant.revoked)
      return false;
    grant.revoked = true;
    return true;
  };
  const authorizeHttp = (request, principal, context = {}) => {
    const expired = ensureActivePrincipal(principal);
    if (expired)
      return expired;
    const safePrincipal = sanitizePrincipal(principal);
    const method = request.method.toUpperCase();
    const url = new URL(request.url);
    const path = url.pathname;
    let operation = context.operation;
    let inferredSession;
    let inferredRecordingId;
    if (operation === undefined) {
      if (method === "GET" && (path === "/ws" || path.startsWith("/ws/"))) {
        operation = "ws-upgrade";
      } else if (!path.startsWith("/api/")) {
        if (method !== "GET" && method !== "HEAD")
          return fail403("forbidden_operation");
        operation = "static";
      } else if (method === "GET" && (path === "/api/auth" || path === "/api/auth/description")) {
        operation = "auth-description";
      } else if (method === "GET" && path === "/api/sessions") {
        operation = "sessions-list";
      } else if (method === "POST" && (path === "/api/spawn" || path === "/api/sessions")) {
        operation = "sessions-spawn";
      } else if (method === "POST" && (path === "/api/upload" || path === "/api/uploads")) {
        operation = "upload";
      } else if (method === "GET" && path === "/api/recordings") {
        operation = "recordings-list";
      } else if (method === "POST" && path === "/api/recordings/start") {
        operation = "recording-start";
      } else if (method === "POST" && path === "/api/recordings/stop") {
        operation = "recording-stop";
      } else {
        const lifecycle = /^\/api\/sessions\/([^/]+)\/recording\/(start|stop)$/.exec(path);
        const download = /^\/api\/recordings\/([^/]+)\/download$/.exec(path);
        if (method === "POST" && lifecycle) {
          inferredSession = decodePathSegment(lifecycle[1] ?? "") ?? undefined;
          operation = lifecycle[2] === "start" ? "recording-start" : "recording-stop";
        } else if (method === "GET" && download) {
          inferredRecordingId = decodePathSegment(download[1] ?? "") ?? undefined;
          operation = "recordings-download";
        } else {
          return fail403("forbidden_operation");
        }
      }
    }
    if (operation === "static" || operation === "auth-description" || operation === "ws-upgrade" || operation === "sessions-list") {
      return { ok: true, status: 200, operation };
    }
    if (operation === "sessions-spawn") {
      if (safePrincipal.scope !== "interactive")
        return fail403("forbidden_scope");
      if (safePrincipal.sessions !== undefined)
        return fail403("forbidden_scope");
      return { ok: true, status: 200, operation };
    }
    if (operation === "upload") {
      if (safePrincipal.scope !== "interactive")
        return fail403("forbidden_scope");
      if (context.session !== undefined) {
        if (!isNonEmptySession(context.session))
          return fail403("forbidden_operation");
        if (!isSessionAllowed(safePrincipal, context.session))
          return fail403("forbidden_session");
        return { ok: true, status: 200, operation: "upload", session: context.session };
      }
      return { ok: true, status: 200, operation: "upload" };
    }
    if (operation === "recordings-list") {
      const parsed = parseSingleQueryValue(url.search, "session");
      if (parsed.malformed)
        return fail403("forbidden_operation");
      if (context.session !== undefined && parsed.value !== undefined && context.session !== parsed.value) {
        return fail403("forbidden_operation");
      }
      const session = context.session ?? parsed.value;
      if (!isNonEmptySession(session))
        return fail403("forbidden_operation");
      if (!isSessionAllowed(safePrincipal, session))
        return fail403("forbidden_session");
      return { ok: true, status: 200, operation, session };
    }
    if (operation === "recording-start" || operation === "recording-stop") {
      if (context.session !== undefined && inferredSession !== undefined && context.session !== inferredSession) {
        return fail403("forbidden_operation");
      }
      const session = context.session ?? inferredSession;
      if (!isNonEmptySession(session))
        return fail403("forbidden_operation");
      if (safePrincipal.scope !== "interactive")
        return fail403("forbidden_scope");
      if (!isSessionAllowed(safePrincipal, session))
        return fail403("forbidden_session");
      return { ok: true, status: 200, operation, session };
    }
    if (operation === "recordings-download") {
      if (context.recordingId !== undefined && inferredRecordingId !== undefined && context.recordingId !== inferredRecordingId) {
        return fail403("forbidden_operation");
      }
      const recordingId = context.recordingId ?? inferredRecordingId;
      if (!isNonEmptySession(recordingId))
        return fail403("forbidden_operation");
      let resolved;
      if (options.recordingSessionResolver) {
        try {
          const raw = options.recordingSessionResolver(recordingId);
          resolved = typeof raw === "string" && raw.length > 0 ? raw : undefined;
        } catch {
          return fail403("forbidden_operation");
        }
      }
      if (context.session !== undefined && resolved !== undefined && context.session !== resolved) {
        return fail403("forbidden_operation");
      }
      const session = resolved ?? context.session;
      if (safePrincipal.sessions !== undefined) {
        if (!isNonEmptySession(session) || !isSessionAllowed(safePrincipal, session)) {
          return fail403("forbidden_session");
        }
      }
      return { ok: true, status: 200, operation, session: session ?? recordingId };
    }
    return fail403("forbidden_operation");
  };
  const authorizeMuxMessage = (message, principal) => {
    const expired = ensureActivePrincipal(principal);
    if (expired)
      return expired;
    const safePrincipal = sanitizePrincipal(principal);
    const raw = message;
    if (typeof raw !== "object" || raw === null || typeof raw.type !== "string") {
      return fail403("forbidden_operation");
    }
    const type = raw.type;
    switch (type) {
      case "ping":
      case "client_info":
      case "sessions_subscribe":
      case "sessions_unsubscribe":
        return {
          ok: true,
          status: 200,
          operation: type
        };
      case "subscribe":
      case "unsubscribe":
      case "history_expand":
      case "resync": {
        const session = raw.session;
        if (!isNonEmptySession(session))
          return fail403("forbidden_operation");
        if (!isSessionAllowed(safePrincipal, session))
          return fail403("forbidden_session");
        return { ok: true, status: 200, operation: type, session };
      }
      case "keys": {
        if (safePrincipal.scope !== "interactive")
          return fail403("forbidden_scope");
        const session = raw.session;
        const data = raw.data;
        if (!isNonEmptySession(session) || typeof data !== "string")
          return fail403("forbidden_operation");
        if (!isSessionAllowed(safePrincipal, session))
          return fail403("forbidden_session");
        return { ok: true, status: 200, operation: "keys", session };
      }
      case "resize": {
        if (safePrincipal.scope !== "interactive")
          return fail403("forbidden_scope");
        const session = raw.session;
        const cols = raw.cols;
        const rows = raw.rows;
        if (!isNonEmptySession(session) || !isInteger(cols) || !isInteger(rows) || cols <= 0 || rows <= 0) {
          return fail403("forbidden_operation");
        }
        if (!isSessionAllowed(safePrincipal, session))
          return fail403("forbidden_session");
        return { ok: true, status: 200, operation: "resize", session };
      }
      default:
        return fail403("forbidden_operation");
    }
  };
  const filterSessions = (sessions, principal, nameOf = extractSession) => {
    if (ensureActivePrincipal(principal))
      return [];
    const safePrincipal = sanitizePrincipal(principal);
    if (safePrincipal.sessions === undefined)
      return [...sessions];
    if (safePrincipal.sessions.length === 0)
      return [];
    const allow = new Set(safePrincipal.sessions);
    return sessions.filter((item) => {
      const name = nameOf(item);
      return typeof name === "string" && allow.has(name);
    });
  };
  const wrapped = {
    options: {
      queryParamName,
      cookieName,
      redactionPlaceholder
    },
    authenticate,
    authorizeHttp,
    authorizeMuxMessage: (message, principal) => authorizeMuxMessage(message, principal),
    createSocketPrincipal,
    sanitizePrincipal,
    isSessionAllowed,
    filterSessions: (sessions, principal, nameOf) => filterSessions(sessions, principal, nameOf),
    makeCookieHeader: (grant, req) => makeCookieHeader(grant, req),
    redact: (text) => redact(text),
    revoke
  };
  return wrapped;
}
export {
  spawnTmuxSession,
  killTmuxSession,
  createUploadHandler,
  createTokenGuard,
  createPrefsHandler,
  createBunTmuxDriver,
  TmuxWsMux,
  FrameJournal,
  DEFAULT_MAX_ROOT_BYTES,
  DEFAULT_MAX_BYTES
};
