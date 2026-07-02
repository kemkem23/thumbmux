/**
 * thumbmux WS protocol — the message shapes exchanged between the browser
 * mux client (@thumbmux/svelte ws-mux) and the server mux (@thumbmux/server).
 * One connection multiplexes many sessions; `channel` = session name, with
 * the reserved `__sessions` channel carrying session-list pushes.
 */

/** Client → server. */
export type MuxClientMessage = {
  type:
    | "ping"
    | "client_info"
    | "subscribe"
    | "unsubscribe"
    | "keys"
    | "resize"
    | "sessions_subscribe"
    | "sessions_unsubscribe"
    | "history_expand";
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
  type: "output" | "sessions" | "history" | "error";
  data: string;
};

export type MuxOutputType = "output" | "history" | "error";

/** Optional descriptor a client attaches to its messages — the server may
 * feed it to policy hooks (kemcortex: terminal size arbiter + UX telemetry). */
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
