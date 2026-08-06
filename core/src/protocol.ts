/**
 * thumbmux WS protocol — the message shapes exchanged between the browser
 * mux client (thumbmux/svelte ws-mux) and the server mux (thumbmux/server).
 * One connection multiplexes many sessions; `channel` = session name, with
 * the reserved `__sessions` channel carrying session-list pushes.
 */

export type MuxCursor = { row: number; col: number };

/** tmux pane screen-mode sample: alternate buffer + SGR / any-event mouse. */
export interface MuxPaneScreen { alt: boolean; mouseSgr: boolean; mouseAny: boolean; }

/**
 * Minimum row inside the JSON-encoded `data` of a `__sessions` frame.
 *
 * Only `name` is required by the protocol. Server APIs use this no-index-
 * signature type as their generic constraint, so interface-declared host rows
 * may carry any additional metadata without casts or invented tmux fields.
 */
export type SessionListRow = {
  name: string;
};

/**
 * Complete row emitted by `createBunTmuxDriver()`.
 * Custom drivers/providers may select their own `SessionListRow` subtype via
 * the server API generics instead of manufacturing these tmux-owned fields.
 */
export type SessionListItem = SessionListRow & {
  /** Package-filled tmux creation timestamp (epoch seconds as a string). */
  created: string;
  /** Package-filled tmux window count. */
  windows: number;
  /** Package-filled tmux attachment state. */
  attached: boolean;
  /** Package-filled latest tmux window activity (epoch seconds, or `0` before a sample). */
  activityAt: number;
  /** Additional metadata is preserved on the stock session-list wire type. */
  [key: string]: unknown;
};

/** A complete output base. `data.split("\n")` is the exact delta base. */
export type MuxFullOutputFrame = {
  channel: string;
  type: "output";
  data: string;
  cursor?: MuxCursor | null;
  /** Present when the driver samples pane screen mode (alt buffer + mouse). */
  screen?: MuxPaneScreen | null;
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
  /** Present when the driver samples pane screen mode (alt buffer + mouse). */
  screen?: MuxPaneScreen | null;
};

export type MuxOutputFrame = MuxFullOutputFrame | MuxDeltaFrame;

export type MuxResyncRequest = { type: "resync"; session: string };

/**
 * Client → server.
 *
 * Fields beyond `type` stay optional on the frozen shape so 0.9.1 consumers that
 * construct partial literals still typecheck (A1-10 is a real gap; narrowing
 * here would be a breaking type change deferred past 0.9.2). Runtime still
 * validates required fields per op. Prefer {@link MuxStrictClientMessage} for
 * new typed clients.
 */
export type MuxClientMessage = MuxResyncRequest | {
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
  /** subscribe option: opt in to delta output frames for this session. */
  delta?: boolean;
  cols?: number;
  rows?: number;
  /** Exclusive upper anchor for backward archive paging. */
  beforeLine?: number | null;
  /** Exclusive lower anchor for forward archive paging; presence selects that direction. */
  afterLine?: number | null;
  limit?: number;
  client?: unknown;
};

/**
 * Additive stricter client-message union (A1-10). Existing {@link MuxClientMessage}
 * stays loose for back-compat; new code should prefer this shape.
 */
export type MuxStrictClientMessage =
  | MuxResyncRequest
  | { type: "ping"; client?: unknown }
  | { type: "client_info"; client?: unknown }
  | { type: "subscribe" | "unsubscribe"; session: string; tail?: number; delta?: boolean; client?: unknown }
  | { type: "keys"; session: string; data: string; client?: unknown }
  | { type: "resize"; session: string; cols: number; rows: number; client?: unknown }
  | { type: "sessions_subscribe" | "sessions_unsubscribe"; client?: unknown }
  | {
      type: "history_expand";
      session: string;
      beforeLine?: number | null;
      afterLine?: number | null;
      limit?: number;
      client?: unknown;
    };

/**
 * Server → client channel-bearing frames (session stream).
 *
 * `sessions` / `history` / `error` require `data` (JSON string / page / message).
 * `cursor` updates only the caret and never carries `data`.
 * `{type:"pong"}` is channel-less — see {@link MuxPongFrame} on {@link MuxServerFrame}.
 */
export type MuxServerMessage = MuxOutputFrame | {
  channel: string;
  type: "sessions" | "history" | "error";
  /** On a `__sessions` frame this is JSON-encoded `SessionListRow[]`; the bundled
   * tmux driver emits the richer `SessionListItem[]` shape. History pages and
   * error strings are also required non-optional payloads. */
  data: string;
  cursor?: MuxCursor | null;
} | {
  channel: string;
  type: "cursor";
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

/** Reply to `{type:"ping"}` — channel-less keepalive acknowledgement. */
export type MuxPongFrame = { type: "pong" };

/** A channel-less authorization denial sent by guarded routes. */
export type MuxAuthErrorFrame = {
  type: "auth_error";
  status: 401 | 403;
  code: string;
  /** Authorization denials never carry terminal cursor data. */
  cursor?: never;
};

/** All typed server frames, including pong and guarded-route authorization denials. */
export type MuxServerFrame = MuxServerMessage | MuxPongFrame | MuxAuthErrorFrame;

/** Delivery types exposed to existing mux subscribers (wire deltas reconstruct as output). */
export type MuxOutputType = "output" | "history" | "error" | "cursor";

/** Split an output frame without losing an intentional trailing empty line. */
export function splitMuxOutputData(data: string): string[] {
  return data.split("\n");
}

/** Reused across calls — TextEncoder is stateless for encode(). */
const UTF8_ENCODER = new TextEncoder();

/**
 * Portable lowercase FNV-1a-32 over the UTF-8 bytes of a string.
 * Indexed loop (not for-of) — for-of on Uint8Array allocates an iterator
 * result object per byte and was the dominant cost on ~348 KB delta bases.
 */
export function fnv1a32(value: string): string {
  const bytes = UTF8_ENCODER.encode(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The required prefix hash for a raw output-line base. */
export function muxPrefixHash(lines: readonly string[]): string {
  return fnv1a32(JSON.stringify(lines));
}

/** Count equal raw lines from the beginning of two output bases. */
export function muxCommonPrefixLength(base: readonly string[], next: readonly string[]): number {
  const limit = Math.min(base.length, next.length);
  let prefix = 0;
  while (prefix < limit && base[prefix] === next[prefix]) prefix += 1;
  return prefix;
}

/** Build a complete replacement-suffix delta. */
export function createMuxDeltaFrame(
  channel: string,
  base: readonly string[],
  next: readonly string[],
  cursor?: MuxCursor | null,
  screen?: MuxPaneScreen | null,
): MuxDeltaFrame {
  const prefix = muxCommonPrefixLength(base, next);
  const frame: MuxDeltaFrame = {
    channel,
    type: "delta",
    baseLength: base.length,
    prefix,
    prefixHash: muxPrefixHash(base.slice(0, prefix)),
    lines: next.slice(prefix),
  };
  if (cursor !== undefined) frame.cursor = cursor;
  if (screen !== undefined) frame.screen = screen;
  return frame;
}

function isMuxCursor(value: unknown): value is MuxCursor | null {
  if (value === null) return true;
  if (typeof value !== "object" || value === null) return false;
  const cursor = value as Record<string, unknown>;
  // `col` is 0-based cells (never negative); `row` may be negative (caret below
  // the last content line). Rejecting negative col keeps malformed carets from
  // applying silently (A1-12).
  return (
    Number.isInteger(cursor.row) &&
    Number.isInteger(cursor.col) &&
    (cursor.col as number) >= 0
  );
}

function isMuxPaneScreen(value: unknown): value is MuxPaneScreen | null {
  if (value === null) return true;
  if (typeof value !== "object" || value === null) return false;
  const screen = value as Record<string, unknown>;
  return (
    typeof screen.alt === "boolean" &&
    typeof screen.mouseSgr === "boolean" &&
    typeof screen.mouseAny === "boolean"
  );
}

/**
 * Validate a received delta against its current raw base. Invalid deltas must
 * not update either content or cursor; callers can request one resync instead.
 */
export function validateMuxDeltaFrame(
  frame: unknown,
  base: readonly string[],
): MuxDeltaFrame | null {
  if (typeof frame !== "object" || frame === null) return null;
  const candidate = frame as Record<string, unknown>;
  if (candidate.channel === undefined || typeof candidate.channel !== "string") return null;
  if (candidate.type !== "delta") return null;
  const baseLength = candidate.baseLength;
  const prefix = candidate.prefix;
  if (typeof baseLength !== "number" || !Number.isInteger(baseLength) || baseLength !== base.length) return null;
  if (typeof prefix !== "number" || !Number.isInteger(prefix) || prefix < 0 || prefix > base.length) return null;
  if (typeof candidate.prefixHash !== "string") return null;
  if (candidate.prefixHash !== muxPrefixHash(base.slice(0, prefix))) return null;
  if (!Array.isArray(candidate.lines) || !candidate.lines.every((line) => typeof line === "string")) return null;

  if (Object.prototype.hasOwnProperty.call(candidate, "cursor") && !isMuxCursor(candidate.cursor)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(candidate, "screen") && !isMuxPaneScreen(candidate.screen)) {
    return null;
  }

  return candidate as unknown as MuxDeltaFrame;
}

/** Reconstruct a new complete raw base, or return null for an invalid delta. */
export function applyMuxDelta(
  base: readonly string[],
  frame: unknown,
): string[] | null {
  const delta = validateMuxDeltaFrame(frame, base);
  return delta ? base.slice(0, delta.prefix).concat(delta.lines) : null;
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** The exact serialized JSON UTF-8 size used for full-versus-delta choice. */
export function serializedMuxFrameSize(frame: MuxOutputFrame): number {
  return utf8Size(JSON.stringify(frame));
}

/** Deltas are eligible only with a non-empty prefix and a strict byte saving. */
export function shouldUseMuxDelta(
  full: MuxFullOutputFrame,
  delta: MuxDeltaFrame,
): boolean {
  return full.reset === undefined
    && delta.prefix > 0
    && serializedMuxFrameSize(delta) < serializedMuxFrameSize(full);
}

/** Select the strict-smaller wire representation for a known full frame/base. */
export function chooseMuxOutputFrame(
  full: MuxFullOutputFrame,
  base: readonly string[],
): MuxOutputFrame {
  const delta = createMuxDeltaFrame(
    full.channel,
    base,
    splitMuxOutputData(full.data),
    full.cursor,
    full.screen,
  );
  return shouldUseMuxDelta(full, delta) ? delta : full;
}

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
