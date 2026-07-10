/**
 * thumbmux WS protocol — the message shapes exchanged between the browser
 * mux client (@thumbmux/svelte ws-mux) and the server mux (@thumbmux/server).
 * One connection multiplexes many sessions; `channel` = session name, with
 * the reserved `__sessions` channel carrying session-list pushes.
 */
/** Client → server. */
export type MuxClientMessage = {
    type: "ping" | "client_info" | "subscribe" | "unsubscribe" | "keys" | "resize" | "sessions_subscribe" | "sessions_unsubscribe" | "history_expand";
    session?: string;
    data?: string;
    /** subscribe option: only stream the last N pane lines (thumbnail mode —
     * full snapshots are 50-140KB, a tail is a few KB) */
    tail?: number;
    cols?: number;
    rows?: number;
    beforeLine?: number | null;
    limit?: number;
    client?: unknown;
};
/** Server → client (plus `{type:"pong"}` replies to pings). */
export type MuxServerMessage = {
    channel: string;
    type: "output" | "sessions" | "history" | "error" | "cursor";
    /** Absent on "cursor" frames — they update only the caret. */
    data?: string;
    /** On output frames: the pane's real cursor, or null when hidden.
     * `row` counts up from the LAST CONTENT line (trailing blank viewport rows
     * trimmed), `col` is 0-based cells — the same convention for full and
     * tail-sliced frames. `row` may be NEGATIVE: the caret sits |row| blank
     * rows BELOW the last content line (shell waiting after output that ended
     * in a newline) — rows a trimming server may not have sent as text.
     * A standalone `type:"cursor"` frame carries ONLY this field: sent when the
     * cursor moved but the pane content did not (e.g. arrow keys on a shell
     * line), so viewers never render a stale caret and the pane text is not
     * re-sent. */
    cursor?: {
        row: number;
        col: number;
    } | null;
};
export type MuxOutputType = "output" | "history" | "error" | "cursor";
/** Optional descriptor a client attaches to its messages — the server may
 * feed it to policy hooks (e.g. a terminal-size arbiter + UX telemetry). */
export type MuxClientInfo = {
    href?: string;
    pathname?: string;
    userAgent?: string;
    language?: string;
    platform?: string;
    visibilityState?: string;
    /** Host-supplied id linking this connection to host telemetry. */
    uxClientId?: string;
    viewport?: {
        width?: number;
        height?: number;
        visualWidth?: number;
        visualHeight?: number;
        screenWidth?: number;
        screenHeight?: number;
        devicePixelRatio?: number;
    };
};
