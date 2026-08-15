import type { HistoryArchiveLike, TmuxDriver } from "./ws-mux";

/**
 * Keep sessions archived when nobody is watching them.
 *
 * A terminal viewer archives what someone is looking at, which is reasonable
 * for a viewer and fatal for a history: an agent working alone stops being
 * archived the moment the last tab closes.
 *
 * This is a separate object rather than a mode of `TmuxWsMux` on purpose. It
 * produces no frames and has no viewers, so none of the mux's machinery applies
 * to it; all it shares is a driver and an archive. Keeping it out of the mux
 * also keeps a viewer engine from quietly becoming a daemon.
 *
 * Nothing starts until `start()` is called, and even then only the sessions the
 * host lists are touched — which sessions matter is host policy, read fresh
 * every tick so there is no second copy of it here to drift.
 */

export type RetentionLaneOptions = {
  driver: Pick<TmuxDriver, "capturePane" | "getHistoryLimit" | "listSessions">;
  /** Must implement `appendAnchored`; a lane cannot do its job without it. */
  archive: HistoryArchiveLike;
  /** Sessions to keep archiving, read fresh on every tick. */
  sessions: () => readonly string[];
  /** Rows the viewer treats as live. Also the fallback for an unknown pane height. */
  liveLineLimit: number;
  /** How often to capture. Default 30000. */
  intervalMs?: number;
  /**
   * True while a viewer owns this session. Those are already captured several
   * times a second through the same archive, so the lane stands back. Hosts wire
   * this from the mux's subscribe/unsubscribe hooks; without it the lane simply
   * captures everything it is given.
   */
  hasViewers?: (session: string) => boolean;
  /** Called after every attempt, successful or not. */
  onStatus?: (status: RetentionLaneStatus) => void;
  log?: (...args: unknown[]) => void;
};

export type RetentionLaneStatus = {
  session: string;
  lastCaptureAt: number;
  lastArchivedAt: number | null;
  archivedLines: number;
  gaps: number;
  lastError: string | null;
};

/** Split a capture the way the archive expects: no terminator, no blank tail. */
function splitCapture(content: string): string[] {
  const terminated = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (terminated === "") return [];
  const lines = terminated.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

export class RetentionLane {
  private readonly options: RetentionLaneOptions;
  private readonly intervalMs: number;
  private readonly statuses = new Map<string, RetentionLaneStatus>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: RetentionLaneOptions) {
    if (!options.archive.appendAnchored) {
      // Falling back to the viewer-shaped ingest would keep the lane looking
      // healthy while losing history, which is the failure this exists to end.
      throw new Error("thumbmux: RetentionLane requires an archive with appendAnchored");
    }
    this.options = options;
    this.intervalMs = Math.max(1, Math.floor(options.intervalMs ?? 30_000));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** What the lane has managed for each session it has seen. */
  status(): readonly RetentionLaneStatus[] {
    return [...this.statuses.values()];
  }

  /** One pass over the host's list. Called by the timer; public so a host — or
   *  a test — can drive it directly instead of waiting. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const session of this.options.sessions()) {
        if (this.options.hasViewers?.(session)) continue;
        await this.capture(session);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async capture(session: string): Promise<void> {
    const status = this.statuses.get(session) ?? {
      session,
      lastCaptureAt: 0,
      lastArchivedAt: null,
      archivedLines: 0,
      gaps: 0,
      lastError: null,
    };
    this.statuses.set(session, status);

    const archive = this.options.archive;
    // Called through the archive, never as a detached function: an archive that
    // implements this as a class method loses `this` the moment it is pulled
    // into a local. The unit spies here are closures and could not see that; the
    // live-tmux test failed on the first run.
    const append = (
      lines: readonly string[],
      opts: { paneRows: number; liveLineLimit: number; deeperAvailable?: boolean },
    ) => archive.appendAnchored!(session, lines, opts);
    const liveLineLimit = this.options.liveLineLimit;
    const paneRows = this.paneRows(session);
    try {
      let lines = splitCapture(await this.options.driver.capturePane(session, {
        startLine: -liveLineLimit * 2,
      }));
      status.lastCaptureAt = Date.now();
      let result = append(lines, { paneRows, liveLineLimit, deeperAvailable: true });
      if (result.needsDeeper) {
        // One expensive capture answers "did tmux drop it, or did I look too
        // late" — and only after that is a gap marker honest.
        const deep = -Math.max(this.options.driver.getHistoryLimit(), liveLineLimit);
        lines = splitCapture(await this.options.driver.capturePane(session, { startLine: deep }));
        status.lastCaptureAt = Date.now();
        result = append(lines, { paneRows, liveLineLimit });
      }
      if (result.appended > 0) {
        status.archivedLines += result.appended;
        status.lastArchivedAt = Date.now();
      }
      if (result.gap) status.gaps++;
      status.lastError = null;
    } catch (cause) {
      status.lastError = cause instanceof Error ? cause.message : String(cause);
      try {
        this.options.log?.(`[thumbmux-retention] capture failed for "${session}":`, status.lastError);
      } catch {}
    }

    // Report every attempt, not only the ones that worked: a lane that speaks up
    // only on success is indistinguishable from a lane that stopped running.
    try {
      this.options.onStatus?.({ ...status });
    } catch {
      // A telemetry tap must never break the lane that feeds it.
    }
  }

  /**
   * The visible screen is the only part of a capture tmux can still repaint.
   * When the host's session row carries no height, fall back to the live window
   * — deeper than any real pane, so an unknown height stores less rather than
   * storing rows that may still change.
   */
  private paneRows(session: string): number {
    for (const row of this.options.driver.listSessions()) {
      if ((row as { name?: unknown }).name !== session) continue;
      const paneRows = (row as { paneRows?: unknown }).paneRows;
      if (typeof paneRows === "number" && Number.isFinite(paneRows) && paneRows > 0) {
        return Math.floor(paneRows);
      }
      break;
    }
    return this.options.liveLineLimit;
  }
}
