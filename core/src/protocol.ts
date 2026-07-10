/**
 * thumbmux WS protocol — the message shapes exchanged between the browser
 * mux client (@thumbmux/svelte ws-mux) and the server mux (@thumbmux/server).
 * One connection multiplexes many sessions; `channel` = session name, with
 * the reserved `__sessions` channel carrying session-list pushes.
 */

export type MuxCursor = { row: number; col: number };

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

export type MuxResyncRequest = { type: "resync"; session: string };

/** Client → server. */
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
export function splitMuxOutputData(data: string): string[] {
  return data.split("\n");
}

/** Portable lowercase FNV-1a-32 over the UTF-8 bytes of a string. */
export function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
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
  return frame;
}

function isMuxCursor(value: unknown): value is MuxCursor | null {
  if (value === null) return true;
  if (typeof value !== "object" || value === null) return false;
  const cursor = value as Record<string, unknown>;
  return Number.isInteger(cursor.row) && Number.isInteger(cursor.col);
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
