/**
 * thumbmux WS protocol — the message shapes exchanged between the browser
 * mux client (@thumbmux/svelte ws-mux) and the server mux (@thumbmux/server).
 * One connection multiplexes many sessions; `channel` = session name, with
 * the reserved `__sessions` channel carrying session-list pushes.
 */
export type MuxCursor = {
    row: number;
    col: number;
};
/** A complete output base. `data.split("\n")` is the exact delta base. */
export type MuxFullOutputFrame = {
    channel: string;
    type: "output";
    data: string;
    cursor?: MuxCursor | null;
    reset?: "resize" | "resync";
};
/** A replacement suffix relative to the recipient's most recent full base. */
export type MuxDeltaFrame = {
    channel: string;
    type: "delta";
    baseLength: number;
    prefix: number;
    prefixHash: string;
    lines: string[];
    cursor?: MuxCursor | null;
};
export type MuxOutputFrame = MuxFullOutputFrame | MuxDeltaFrame;
export type MuxResyncRequest = {
    type: "resync";
    session: string;
};
/** Client → server. */
export type MuxClientMessage = MuxResyncRequest | {
    type: "ping" | "client_info" | "subscribe" | "unsubscribe" | "keys" | "resize" | "sessions_subscribe" | "sessions_unsubscribe" | "history_expand";
    session?: string;
    data?: string;
    /** subscribe option: only stream the last N pane lines (thumbnail mode —
     * full snapshots are 50-140KB, a tail is a few KB) */
    tail?: number;
    /** subscribe option: opt in to delta output frames for this session. */
    delta?: boolean;
    cols?: number;
    rows?: number;
    beforeLine?: number | null;
    limit?: number;
    client?: unknown;
};
/** Server → client (plus `{type:"pong"}` replies to pings). */
export type MuxServerMessage = MuxOutputFrame | {
    channel: string;
    type: "sessions" | "history" | "error" | "cursor";
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
    cursor?: MuxCursor | null;
};
/** Delivery types exposed to existing mux subscribers (wire deltas reconstruct as output). */
export type MuxOutputType = "output" | "history" | "error" | "cursor";
/** Split an output frame without losing an intentional trailing empty line. */
export declare function splitMuxOutputData(data: string): string[];
/** Portable lowercase FNV-1a-32 over the UTF-8 bytes of a string. */
export declare function fnv1a32(value: string): string;
/** The required prefix hash for a raw output-line base. */
export declare function muxPrefixHash(lines: readonly string[]): string;
/** Count equal raw lines from the beginning of two output bases. */
export declare function muxCommonPrefixLength(base: readonly string[], next: readonly string[]): number;
/** Build a complete replacement-suffix delta. */
export declare function createMuxDeltaFrame(channel: string, base: readonly string[], next: readonly string[], cursor?: MuxCursor | null): MuxDeltaFrame;
/**
 * Validate a received delta against its current raw base. Invalid deltas must
 * not update either content or cursor; callers can request one resync instead.
 */
export declare function validateMuxDeltaFrame(frame: unknown, base: readonly string[]): MuxDeltaFrame | null;
/** Reconstruct a new complete raw base, or return null for an invalid delta. */
export declare function applyMuxDelta(base: readonly string[], frame: unknown): string[] | null;
/** The exact serialized JSON UTF-8 size used for full-versus-delta choice. */
export declare function serializedMuxFrameSize(frame: MuxOutputFrame): number;
/** Deltas are eligible only with a non-empty prefix and a strict byte saving. */
export declare function shouldUseMuxDelta(full: MuxFullOutputFrame, delta: MuxDeltaFrame): boolean;
/** Select the strict-smaller wire representation for a known full frame/base. */
export declare function chooseMuxOutputFrame(full: MuxFullOutputFrame, base: readonly string[]): MuxOutputFrame;
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
