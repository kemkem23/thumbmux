import type { HistoryArchiveLike, TmuxDriver } from "./ws-mux.js";
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
export declare class RetentionLane {
    private readonly options;
    private readonly intervalMs;
    private readonly statuses;
    private timer;
    private ticking;
    constructor(options: RetentionLaneOptions);
    start(): void;
    stop(): void;
    /** What the lane has managed for each session it has seen. */
    status(): readonly RetentionLaneStatus[];
    /** One pass over the host's list. Called by the timer; public so a host — or
     *  a test — can drive it directly instead of waiting. */
    tick(): Promise<void>;
    private capture;
    /**
     * The visible screen is the only part of a capture tmux can still repaint.
     * When the host's session row carries no height, fall back to the live window
     * — deeper than any real pane, so an unknown height stores less rather than
     * storing rows that may still change.
     */
    private paneRows;
}
