// src/ws-mux.ts
var DEFAULT_PROFILE = { resize: true, currentPaneOnly: false, archive: true };

class TmuxWsMux {
  compressFrames = false;
  wsSend(ws, data) {
    if (this.compressFrames)
      ws.send(data, true);
    else
      ws.send(data);
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
  lastReconcileCapture = new Map;
  lastAppliedGeometry = new Map;
  sessionListProvider;
  tails = new Map;
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
    const profile = this.profileOf(session);
    const cachedContent = this.contents.get(session);
    if (cachedContent !== undefined) {
      try {
        this.wsSend(ws, JSON.stringify({
          channel: session,
          type: "output",
          data: this.contentFor(session, ws, cachedContent),
          cursor: this.lastCursor.get(session) ?? null
        }));
      } catch {}
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
    if (!this.piped.has(session)) {
      this.tryStartPipe(session);
    }
  }
  unsubscribe(session, ws, client) {
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
  unsubscribeAll(ws) {
    this.hooks.onSocketClose?.(ws);
    this.sessionListSubscribers.delete(ws);
    for (const t of this.tails.values())
      t.delete(ws);
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
  dropSessionState(session) {
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
          this.subscribe(msg.session, ws, msg.client, { tail: msg.tail });
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
    }
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
    this.pipes?.handleRename(oldSession);
    if (this.piped.has(oldSession)) {
      this.piped.delete(oldSession);
      this.tryStartPipe(newSession);
    }
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
      const liveContent = !useArchive ? content : this.archive.ingestSnapshot(session, content, {
        previousContent,
        fullHistory: !!opts.fullHistory,
        liveLineLimit: this.liveLineLimit
      }).liveContent;
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
        if (this.driver.captureWithCursor) {
          const cursor2 = this.mapRawCursor(rawCursor, trailingBlanks ?? 0);
          if (!this.cursorEq(cursor2, this.lastCursor.get(session))) {
            this.lastCursor.set(session, cursor2);
            const cursorMsg = JSON.stringify({ channel: session, type: "cursor", cursor: cursor2 });
            for (const ws of viewers) {
              try {
                this.wsSend(ws, cursorMsg);
              } catch {}
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
      const fullMsg = JSON.stringify({ channel: session, type: "output", data: liveContent, cursor });
      const tailMsgs = new Map;
      const tails = this.tails.get(session);
      for (const ws of viewers) {
        const tail = tails?.get(ws);
        if (!tail) {
          try {
            this.wsSend(ws, fullMsg);
          } catch {}
          continue;
        }
        let msg = tailMsgs.get(tail);
        if (!msg) {
          msg = JSON.stringify({
            channel: session,
            type: "output",
            data: this.contentFor(session, ws, liveContent),
            cursor
          });
          tailMsgs.set(tail, msg);
        }
        try {
          this.wsSend(ws, msg);
        } catch {}
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
function run(args) {
  const p = Bun.spawnSync(["tmux", ...args]);
  if (p.exitCode !== 0)
    throw new Error(p.stderr.toString().trim() || `tmux ${args[0]} failed`);
  return p.stdout.toString();
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
      run(["send-keys", "-t", session, "-l", "--", data]);
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
export {
  spawnTmuxSession,
  killTmuxSession,
  createUploadHandler,
  createPrefsHandler,
  createBunTmuxDriver,
  TmuxWsMux
};
