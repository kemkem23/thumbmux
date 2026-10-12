/**
 * thumbmux WS protocol — the message shapes exchanged between the browser
 * mux client (thumbmux/svelte ws-mux) and the server mux (thumbmux/server).
 * One connection multiplexes many sessions; `channel` = session name, with
 * the reserved `__sessions` channel carrying session-list pushes.
 */

export type MuxCursor = { row: number; col: number };

/** tmux pane screen-mode sample: alternate buffer + SGR / any-event mouse. */
export interface MuxPaneScreen {
  /** Authoritative durable preview state; absent for legacy live captures. */
  previewState?: "live" | "orphaned" | "ended" | "unavailable";
  previewHasFrame?: boolean;
  /** Timestamp of the last WAL record backing this verified preview. */
  previewLastSuccessfulAt?: number;
 alt: boolean; mouseSgr: boolean; mouseAny: boolean; }

/**
 * Atomic identity of the durable archive/live seam paired with a pane capture.
 *
 * `generation` changes only when the durable WAL lane is replaced. The three
 * numeric coordinates are monotonic inside one generation. WAL sequence is a
 * decimal string because the recorder uses uint64 values that are not always
 * JSON-safe JavaScript numbers.
 */
export type MuxHistoryBoundary = {
  generation: string;
  liveStartLine: number;
  walSequence: string;
  walOffset: number;
};

export type MuxHistoryBoundaryTransition =
  | "same"
  | "advance"
  | "regression"
  | "generation-mismatch";

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
  /** Durable archive/live seam paired with this exact canonical capture. */
  boundary?: MuxHistoryBoundary;
  reset?: "resize" | "resync";
  /** newarch-frame-v1: projection identity of this snapshot (pipe-pane route only). */
  newarch?: NewarchFrameMeta;
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
  /** Durable archive/live seam paired with the reconstructed capture. */
  boundary?: MuxHistoryBoundary;
  /** newarch-frame-v1 of the reconstructed snapshot; must continue the base's. */
  newarch?: NewarchFrameMeta;
};

/**
 * newarch-frame-v1 — identity of a snapshot served from the pipe-pane
 * projection (NEWARCH L2-I). A delta is valid only on a base of the same
 * pane, source epoch, geometry generation, route generation and live-window
 * start, with a revision that does not go backwards; anything else needs a
 * complete frame (the client asks for a resync). `markers` are the pane's most
 * recent loss/unverified-reset markers: `lineId` is the history row they sit
 * before, `missingCount` null when the size of the gap is unknown.
 */
export type NewarchFrameMeta = {
  v: "newarch-frame-v1";
  paneKey: { serverIdentity: string; paneId: string; birthGeneration: number };
  sourceEpoch: number;
  geometryGeneration: number;
  routeGeneration: number;
  /** Advances for marker/health changes even when terminal cells do not. */
  metadataRevision?: number;
  cols: number;
  rows: number;
  revision: number;
  durableRevision: number;
  nextLineId: number;
  liveStartLine: number;
  displaySource: "pipe" | "tmux-calibrated";
  degraded: boolean;
  markers: Array<{ lineId: number | null; kind: string; missingCount: number | null }>;
};

const NEWARCH_MARKER_LIMIT = 16;

/** Parse and defensively clone a newarch-frame-v1 descriptor; null when malformed. */
export function validateNewarchFrameMeta(value: unknown): NewarchFrameMeta | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const meta = value as Record<string, unknown>;
  const key = meta.paneKey as Record<string, unknown> | null | undefined;
  const count = (n: unknown, min = 0) => Number.isSafeInteger(n) && (n as number) >= min;
  if (
    meta.v !== "newarch-frame-v1"
    || typeof key !== "object" || key === null
    || typeof key.serverIdentity !== "string" || key.serverIdentity.length === 0 || key.serverIdentity.length > 512
    || typeof key.paneId !== "string" || key.paneId.length === 0 || key.paneId.length > 64
    || !count(key.birthGeneration)
    || !count(meta.sourceEpoch) || !count(meta.geometryGeneration) || !count(meta.routeGeneration)
    || (meta.metadataRevision !== undefined && !count(meta.metadataRevision))
    || !count(meta.cols, 1) || !count(meta.rows, 1)
    || !count(meta.revision) || !count(meta.durableRevision) || !count(meta.nextLineId) || !count(meta.liveStartLine)
    || (meta.durableRevision as number) > (meta.revision as number)
    || (meta.liveStartLine as number) > (meta.nextLineId as number)
    || (meta.displaySource !== "pipe" && meta.displaySource !== "tmux-calibrated")
    || typeof meta.degraded !== "boolean"
    || !Array.isArray(meta.markers) || meta.markers.length > NEWARCH_MARKER_LIMIT
  ) return null;
  const markers: NewarchFrameMeta["markers"] = [];
  for (const raw of meta.markers as unknown[]) {
    if (typeof raw !== "object" || raw === null) return null;
    const marker = raw as Record<string, unknown>;
    if ((marker.lineId !== null && !count(marker.lineId)) || typeof marker.kind !== "string" || marker.kind.length === 0
      || marker.kind.length > 64 || (marker.missingCount !== null && !count(marker.missingCount))) return null;
    markers.push({ lineId: marker.lineId as number | null, kind: marker.kind, missingCount: marker.missingCount as number | null });
  }
  return {
    v: "newarch-frame-v1",
    paneKey: { serverIdentity: key.serverIdentity, paneId: key.paneId, birthGeneration: key.birthGeneration as number },
    sourceEpoch: meta.sourceEpoch as number, geometryGeneration: meta.geometryGeneration as number,
    routeGeneration: meta.routeGeneration as number,
    ...(meta.metadataRevision === undefined ? {} : { metadataRevision: meta.metadataRevision as number }),
    cols: meta.cols as number, rows: meta.rows as number,
    revision: meta.revision as number, durableRevision: meta.durableRevision as number,
    nextLineId: meta.nextLineId as number, liveStartLine: meta.liveStartLine as number,
    displaySource: meta.displaySource, degraded: meta.degraded, markers,
  };
}

/**
 * One loss / unverified-reset marker on a projection history page (additive
 * `markers` field of a newarch `history` payload). Same coordinates as
 * {@link NewarchFrameMeta.markers}: the gap sits before row `lineId`.
 */
export type MuxHistoryPageMarker = {
  lineId: number | null;
  kind: string;
  reason?: string;
  missingCount: number | null;
};

/** Most markers one history page may carry on the wire. */
export const HISTORY_PAGE_MARKER_LIMIT = 64;

/**
 * Parse and defensively clone a history page's `markers`. `undefined` (a
 * legacy page) is an empty list; anything malformed or over the limit is null
 * so a caller never draws a guessed position.
 */
export function validateHistoryPageMarkers(value: unknown): MuxHistoryPageMarker[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > HISTORY_PAGE_MARKER_LIMIT) return null;
  const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  const markers: MuxHistoryPageMarker[] = [];
  for (const raw of value as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const marker = raw as Record<string, unknown>;
    if ((marker.lineId !== null && !count(marker.lineId)) || typeof marker.kind !== "string" || marker.kind.length === 0
      || marker.kind.length > 64 || (marker.missingCount !== null && !count(marker.missingCount))
      || (marker.reason !== undefined && (typeof marker.reason !== "string" || marker.reason.length > 512))) return null;
    markers.push({
      lineId: marker.lineId as number | null, kind: marker.kind,
      ...(marker.reason === undefined ? {} : { reason: marker.reason as string }),
      missingCount: marker.missingCount as number | null,
    });
  }
  return markers;
}

/** A delta carrying `next` may apply on a base described by `base`. */
export function newarchDeltaContinues(base: NewarchFrameMeta, next: NewarchFrameMeta): boolean {
  return base.paneKey.serverIdentity === next.paneKey.serverIdentity
    && base.paneKey.paneId === next.paneKey.paneId
    && base.paneKey.birthGeneration === next.paneKey.birthGeneration
    && base.sourceEpoch === next.sourceEpoch
    && base.geometryGeneration === next.geometryGeneration
    && base.routeGeneration === next.routeGeneration
    && (next.metadataRevision ?? 0) >= (base.metadataRevision ?? 0)
    && base.liveStartLine === next.liveStartLine
    && next.revision >= base.revision
    && next.nextLineId >= base.nextLineId;
}

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
export type MuxClientMessage = MuxResyncRequest | NewarchV2HistoryExpandMessage | {
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
  /** NEWARCH v2 history read (Q22 flag-on K-r1, additive); legacy `history_expand` is unchanged. */
  | NewarchV2HistoryExpandMessage
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
  const previewLastSuccessfulAt = screen.previewLastSuccessfulAt;
  return (
    typeof screen.alt === "boolean" &&
    typeof screen.mouseSgr === "boolean" &&
    typeof screen.mouseAny === "boolean" &&
    (previewLastSuccessfulAt === undefined || (
      typeof previewLastSuccessfulAt === "number" &&
      Number.isFinite(previewLastSuccessfulAt) &&
      previewLastSuccessfulAt >= 0
    ))
  );
}

/** Parse and defensively clone a durable seam identity received from the wire. */
export function validateMuxHistoryBoundary(value: unknown): MuxHistoryBoundary | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const boundary = value as Record<string, unknown>;
  if (
    typeof boundary.generation !== "string"
    || boundary.generation.length === 0
    || boundary.generation.length > 256
    || !Number.isSafeInteger(boundary.liveStartLine)
    || (boundary.liveStartLine as number) < 0
    || typeof boundary.walSequence !== "string"
    || !/^(0|[1-9][0-9]{0,19})$/.test(boundary.walSequence)
    || !Number.isSafeInteger(boundary.walOffset)
    || (boundary.walOffset as number) < 0
  ) return null;
  return {
    generation: boundary.generation,
    liveStartLine: boundary.liveStartLine as number,
    walSequence: boundary.walSequence,
    walOffset: boundary.walOffset as number,
  };
}

function compareDecimalStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Classify an incoming seam relative to the last accepted seam. */
export function muxHistoryBoundaryTransition(
  previous: MuxHistoryBoundary,
  next: MuxHistoryBoundary,
): MuxHistoryBoundaryTransition {
  if (previous.generation !== next.generation) return "generation-mismatch";
  const sequenceOrder = compareDecimalStrings(previous.walSequence, next.walSequence);
  const offsetOrder = Math.sign(next.walOffset - previous.walOffset);
  if (
    next.liveStartLine < previous.liveStartLine
    || sequenceOrder > 0
    || offsetOrder < 0
    // Sequence and byte cursor identify the same WAL commit. Advancing only
    // one coordinate is not a valid monotonic head and must fail closed.
    || (sequenceOrder === 0) !== (offsetOrder === 0)
    || (next.liveStartLine > previous.liveStartLine && sequenceOrder === 0)
  ) return "regression";
  return next.liveStartLine === previous.liveStartLine
    && sequenceOrder === 0
    && next.walOffset === previous.walOffset
    ? "same"
    : "advance";
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
  if (
    Object.prototype.hasOwnProperty.call(candidate, "boundary")
    && validateMuxHistoryBoundary(candidate.boundary) === null
  ) return null;

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
  // Rides on the frame rather than through a fifth parameter: `screen` is an
  // optional field on an already-optional-bearing wire shape, and widening a
  // frozen factory's signature to carry it would be a declaration change the
  // additive proof cannot express — for a value this call site already holds.
  if (full.screen !== undefined) delta.screen = full.screen;
  if (full.boundary !== undefined) delta.boundary = full.boundary;
  if (full.newarch !== undefined) delta.newarch = full.newarch;
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

/** Opt-in flag-on extension; legacy frame/page payloads keep their v1 meaning.
 * Negotiate every required capability before sending this envelope. Unknown
 * versions are unsupported, never an empty page. Counts/offsets are safe uints.
 */
export const NEWARCH_HISTORY_EXTENSION_VERSION = 1 as const;
export const NEWARCH_FLAGON_CAPABILITIES = [
  'stitch-v1', 'capture-v1', 'spool-v1', 'receipt-v1', 'bundle-v1',
  'catalog-v3', 'history-states-v1',
] as const;
export type NewarchFlagOnCapability = typeof NEWARCH_FLAGON_CAPABILITIES[number];
export interface NewarchCapabilities {
  readonly extensionVersion: 1;
  readonly supported: readonly NewarchFlagOnCapability[];
  readonly required: readonly NewarchFlagOnCapability[];
}
export interface NewarchPaneKey {
  readonly serverIdentity: string; readonly paneId: string; readonly birthGeneration: number;
}
/** Segment coordinates are NOT legacy global lineId or capture rowIndex. */
export interface NewarchRowId {
  readonly pane: NewarchPaneKey; readonly segmentId: string; readonly rowOrdinal: number;
}
export interface NewarchRowRange {
  readonly pane: NewarchPaneKey; readonly segmentId: string;
  readonly start: number; readonly end: number;
}
export type NewarchMissingCount =
  | { readonly countKind: 'unknown'; readonly missingCount: null }
  | { readonly countKind: 'exact' | 'estimate'; readonly missingCount: number };
export type NewarchGap = NewarchMissingCount & {
  readonly version: 1; readonly episodeId: string; readonly parentEpisodeId: string | null;
  readonly pane: NewarchPaneKey; readonly leftRowId: NewarchRowId | null;
  readonly rightSegmentId: string | null;
  readonly reason: 'pipe-eof' | 'collector-exit' | 'ambiguous-overlap' | 'unproven-overlap'
    | 'unknown-vt-state' | 'interrupted-capture' | 'storage-outage' | 'corruption'
    | 'identity-change' | 'geometry-change' | 'ownership-lost' | 'visible-divergence';
  readonly withheldRows: number; readonly lowerBound: number;
  readonly openedAt: number; readonly closedAt: number | null;
  readonly clockEpoch: string; readonly quality: 'degraded' | 'resolved';
};
/** Opaque serialized token. Only H/A mint/validate it; D must not do arithmetic. */
export interface NewarchHistoryCursor { readonly version: 1; readonly token: string }
export type NewarchHistoryState =
  | { readonly kind: 'exact' }
  | { readonly kind: 'gap'; readonly gap: NewarchGap }
  | { readonly kind: 'pending'; readonly operationId: string; readonly retryAfterMs: number }
  | { readonly kind: 'remote-required'; readonly range: NewarchRowRange; readonly bundleId: string }
  | { readonly kind: 'remote-unavailable'; readonly range: NewarchRowRange; readonly bundleId: string; readonly retryAfterMs: number; readonly reason: 'offline' | 'missing' | 'corrupt' }
  | { readonly kind: 'degraded'; readonly episodeId: string; readonly uncertainFields: readonly string[] }
  | { readonly kind: 'pressure'; readonly level: 'archive' | 'critical' | 'emergency'; readonly collecting: boolean; readonly sinceMonoMs: number };
/** Status is separate from terminal text: copy/search must never include labels.
 * Only end proves EOF. blocked always retains a continuation and readable prefix.
 */
export type NewarchHistoryContinuation =
  | { readonly kind: 'end' }
  | { readonly kind: 'more'; readonly cursor: NewarchHistoryCursor }
  | { readonly kind: 'blocked'; readonly cursor: NewarchHistoryCursor;
      readonly state: Exclude<NewarchHistoryState, { readonly kind: 'exact' }> };
export interface NewarchHistoryExtension {
  readonly version: 1; readonly capabilities: NewarchCapabilities;
  readonly states: readonly NewarchHistoryState[];
  readonly before: NewarchHistoryContinuation; readonly after: NewarchHistoryContinuation;
}

/** Repair capabilities are a separate tagged envelope. Do not advertise them
 * in the v1 list: an old consumer must reject r2, not reinterpret old bytes. */
export const NEWARCH_REPAIR_CAPABILITIES = [
  'cell-sgr-r2', 'digest-provenance-r2', 'attach-receipt-set-r2', 'timeline-replay-r2',
  'spool-retention-r2', 'archive-inventory-r2', 'same-pipe-return-r2', 'incident-r2',
] as const;
export type NewarchRepairCapability = typeof NEWARCH_REPAIR_CAPABILITIES[number];
export interface NewarchRepairCapabilities {
  readonly revision: 2; readonly supported: readonly NewarchRepairCapability[];
  readonly required: readonly NewarchRepairCapability[];
}
/** Unknown revision/capability is unsupported. Both peers' requirements count. */
export function supportsNewarchRepair(local: NewarchRepairCapabilities, peer: {
  readonly revision: number; readonly supported: readonly string[]; readonly required: readonly string[];
}): boolean {
  const known: readonly string[] = NEWARCH_REPAIR_CAPABILITIES;
  return local.revision === 2 && peer.revision === 2
    && [...local.supported, ...local.required, ...peer.required].every(c => known.includes(c))
    && local.required.every(c => local.supported.includes(c) && peer.supported.includes(c))
    && peer.required.every(c => peer.supported.includes(c) && local.supported.some(s => s === c));
}
export interface NewarchGapIdentityR2 {
  readonly revision: 2; readonly gapId: string; readonly sequence: number;
  readonly update: number; readonly state: 'open' | 'closed';
}
export type NewarchGapR2 = NewarchGap & { readonly repair: NewarchGapIdentityR2 };
export interface NewarchIncidentR2 {
  readonly revision: 2; readonly incidentId: string; readonly pane: NewarchPaneKey;
  readonly leftRowId: NewarchRowId | null;
  readonly openedAtWallMs: number; readonly openedAtMonoMs: number; readonly clockEpoch: string;
  readonly collecting: boolean; readonly reason: 'storage-outage' | 'collector-stalled' | 'collector-exit' | 'io';
  readonly quality: 'degraded' | 'resolved'; readonly resolvedAtWallMs: number | null;
}
export type NewarchPressureR2 = Extract<NewarchHistoryState, { readonly kind: 'pressure' }>
  & { readonly repair: NewarchIncidentR2 };
export type NewarchHistoryStateR2 =
  | Exclude<NewarchHistoryState, { readonly kind: 'pressure' } | { readonly kind: 'gap' }>
  | NewarchPressureR2 | { readonly kind: 'gap'; readonly gap: NewarchGapR2 };
export type NewarchHistoryContinuationR2 =
  | { readonly kind: 'end' }
  | { readonly kind: 'more'; readonly cursor: NewarchHistoryCursor }
  | { readonly kind: 'blocked'; readonly cursor: NewarchHistoryCursor;
      readonly state: Exclude<NewarchHistoryStateR2, { readonly kind: 'exact' }> };
export interface NewarchHistoryRepairR2 extends NewarchHistoryExtension {
  readonly repair: NewarchRepairCapabilities;
  readonly states: readonly NewarchHistoryStateR2[];
  readonly before: NewarchHistoryContinuationR2;
  readonly after: NewarchHistoryContinuationR2;
}

/** Q22 / PLAN-v2. This is NOT the repair-r2 envelope above. Never infer v2
 * support from flag-on/repair support. D/U negotiate before sending these
 * messages; old clients may read legacy panes but cannot resize v2 panes. */
export const NEWARCH_V2_SCHEMA = 'newarch-v2' as const;
export const NEWARCH_V2_CAPABILITIES = Object.freeze([
  'permanent-capture-owner', 'fixed-geometry', 'pane-history-cursor',
  'durable-incidents', 'live-checkpoint', 'bounded-audit',
] as const);
export interface NewarchV2Capabilities {
  readonly schema: typeof NEWARCH_V2_SCHEMA;
  readonly supported: readonly string[]; readonly required: readonly string[];
}
export function supportsNewarchV2(local: NewarchV2Capabilities, peer: NewarchV2Capabilities): boolean {
  const known: readonly string[] = NEWARCH_V2_CAPABILITIES;
  return local.schema === NEWARCH_V2_SCHEMA && peer.schema === NEWARCH_V2_SCHEMA
    && [...local.required, ...peer.required].every(c => known.includes(c)
      && local.supported.includes(c) && peer.supported.includes(c))
    && known.every(c => local.required.includes(c) && peer.required.includes(c));
}
/** Session UUID is minted and persisted before birth, never a display name,
 * tmux numeric session id or PID. serverIdentity changes on server recreation. */
export interface NewarchV2SessionKey { readonly serverIdentity: string; readonly sessionId: string }
export interface NewarchV2FixedGeometry {
  readonly policy: 'fixed-at-birth'; readonly columns: number; readonly rows: number;
  readonly configVersion: string; readonly panesPerWindow: 1;
}
export type NewarchV2PaneState = 'reserved' | 'active' | 'stopped' | 'closed' | 'unrecorded';
export interface NewarchV2PaneDescriptor {
  readonly schema: typeof NEWARCH_V2_SCHEMA; readonly session: NewarchV2SessionKey;
  readonly pane: NewarchPaneKey; readonly windowId: string;
  readonly owner: 'capture-engine'; readonly birthOperationId: string;
  readonly geometry: NewarchV2FixedGeometry; readonly state: NewarchV2PaneState;
}
export type NewarchV2PaneSelection =
  | { readonly kind: 'selected'; readonly pane: NewarchV2PaneDescriptor }
  | { readonly kind: 'ambiguous'; readonly panes: readonly NewarchV2PaneDescriptor[]; readonly next: string | null }
  | { readonly kind: 'missing' }
  | { readonly kind: 'owner-unavailable'; readonly retryAfterMs: number };
export type NewarchV2IncidentReason = 'geometry-violation' | 'unverified-restart'
  | 'unrecorded-birth' | 'birth-failed' | 'pipe-eof' | 'collector-epoch-changed'
  | 'storage-outage' | 'budget-exhausted' | 'audit-mismatch' | 'decoder-anomaly' | 'identity-change';
/** Timeline positions, not legacy line numbers. null is before the first row.
 * affected.to=null is open-ended; annotate published rows from last proof,
 * not merely the tail at detection time. Unknown loss is never zero. */
export interface NewarchV2Incident {
  readonly schema: typeof NEWARCH_V2_SCHEMA; readonly incidentId: string;
  readonly pane: NewarchPaneKey; readonly reason: NewarchV2IncidentReason;
  readonly frontier: NewarchRowId | null;
  readonly affected: { readonly after: NewarchRowId | null; readonly through: NewarchRowId | null };
  readonly openedAtWallMs: number; readonly openedAtMonoMs: number; readonly clockEpoch: string;
  readonly collecting: boolean; readonly missing: NewarchMissingCount;
  readonly ruleVersion: string; readonly configVersion: string;
  readonly geometry: NewarchV2FixedGeometry; readonly revision: number;
  readonly sourceEpoch: NewarchV2SourceEpoch | null; readonly sourceOffset: number | null; readonly expectedDigest: string | null; readonly actualDigest: string | null;
  readonly action: 'gap-and-stop' | 'annotate' | 'repair-pending';
  readonly evidence: { readonly digest: string; readonly bytes: number; readonly redacted: true } | null;
}
/** H mints/validates token and binds it to pane/store/timeline revision. Token
 * is opaque, <=4096 UTF-8 bytes. Segment migration MUST NOT change coordinates.
 * Same cursor survives restart; missing/corrupt remote is blocked, never end. */
export interface NewarchV2HistoryCursor {
  readonly schema: typeof NEWARCH_V2_SCHEMA; readonly pane: NewarchPaneKey;
  readonly storeId: string; readonly timelineRevision: number; readonly token: string;
}
export type NewarchV2ReadState =
  | { readonly kind: 'exact'; readonly auditedRevision: number | null }
  | { readonly kind: 'incident'; readonly incident: NewarchV2Incident }
  | { readonly kind: 'storage-unavailable'; readonly pendingIncidentId: string | null; readonly retryAfterMs: number }
  | { readonly kind: 'remote-unavailable'; readonly bundleId: string; readonly reason: 'offline' | 'missing' | 'corrupt'; readonly retryAfterMs: number };
export type NewarchV2Continuation =
  | { readonly kind: 'end' }
  | { readonly kind: 'more'; readonly cursor: NewarchV2HistoryCursor }
  | { readonly kind: 'blocked'; readonly cursor: NewarchV2HistoryCursor;
      readonly state: Extract<NewarchV2ReadState, { readonly kind: 'storage-unavailable' | 'remote-unavailable' }> };
/** No server resize request is implied by viewport/font/fit-to-width changes.
 * D/U use horizontal scrolling by default, no history rewrap. Labels are UI
 * text outside copy/search content, including incidents when no live pane. */
export interface NewarchV2FrameMeta {
  readonly schema: typeof NEWARCH_V2_SCHEMA; readonly pane: NewarchV2PaneDescriptor;
  readonly revision: number; readonly durableRevision: number; readonly sourceEpoch: NewarchV2SourceEpoch;
  readonly state: NewarchV2ReadState;
}
export interface NewarchV2HistoryRequest {
  readonly schema: typeof NEWARCH_V2_SCHEMA; readonly pane: NewarchPaneKey;
  readonly cursor: NewarchV2HistoryCursor | null; readonly direction: 'before' | 'after';
  readonly maxEntries: number; readonly maxBytes: number;
}
export interface NewarchV2GeometryReply {
  readonly schema: typeof NEWARCH_V2_SCHEMA; readonly pane: NewarchPaneKey;
  readonly status: 'fixed'; readonly geometry: NewarchV2FixedGeometry;
}

/** D/I add these to the negotiated transport; v1 frames are not reinterpreted.
 * Delta bases must match pane, sourceEpoch, fixed geometry and not regress
 * revision. Identity/geometry changes require a full reset. */
export type NewarchV2OutputFrame = (Omit<MuxFullOutputFrame, 'newarch'> | Omit<MuxDeltaFrame, 'newarch'>)
  & { readonly newarchV2: NewarchV2FrameMeta };

/** Immutable collector incarnation + attachment, never host receive order. */
export interface NewarchV2SourceEpoch { readonly attachId: string; readonly collectorIncarnation: string }

/** Q22 flag-on (K, 2026-10-05): v2 history request/reply on the mux socket.
 * Additive and separate from `history_expand`/`history` (legacy line anchors):
 * legacy clients never see these frames and a v2 cursor is never flattened to
 * a line number. D3 wires them; D1 answers from H through NewarchV2Display.
 * Numbers mirror NEWARCH_V2_LIMITS (server) and are asserted equal by K. */
export const NEWARCH_V2_WIRE_LIMITS = Object.freeze({
  pageEntries: 256, pageBytes: 2 * 1024 * 1024, cursorBytes: 4096,
} as const);
/** Screen projection of a committed row: provenance (cellOrigins) stays server-side. */
export interface NewarchV2WireCell {
  readonly text: string; readonly width: 0 | 1 | 2; readonly style: readonly number[];
}
export interface NewarchV2WireRow {
  readonly kind: 'row'; readonly id: NewarchRowId; readonly cells: readonly NewarchV2WireCell[];
  readonly wrapStatus: 'wrapped' | 'unwrapped' | 'unknown'; readonly wrapPad: number;
}
export type NewarchV2WireEntry = NewarchV2WireRow
  | { readonly kind: 'incident'; readonly incident: NewarchV2Incident };
/** Client -> server. requestId is client-chosen, echoed verbatim. */
export interface NewarchV2HistoryExpandMessage {
  readonly type: 'history_expand_v2'; readonly session: string; readonly requestId: string;
  readonly request: NewarchV2HistoryRequest;
}
export type NewarchV2HistoryErrorCode = 'wrong-pane' | 'stale-cursor' | 'bounded-read'
  | 'owner-unavailable' | 'unsupported';
/** Server -> client. Entries are ascending timeline order in either direction.
 * An error is never an empty ok page; blocked continuation is never `end`. */
export type NewarchV2HistoryReply =
  | { readonly schema: typeof NEWARCH_V2_SCHEMA; readonly type: 'history_v2'; readonly channel: string;
      readonly requestId: string; readonly status: 'ok'; readonly pane: NewarchPaneKey; readonly revision: number;
      readonly entries: readonly NewarchV2WireEntry[]; readonly payloadBytes: number;
      readonly states: readonly NewarchV2ReadState[];
      readonly before: NewarchV2Continuation; readonly after: NewarchV2Continuation }
  | { readonly schema: typeof NEWARCH_V2_SCHEMA; readonly type: 'history_v2'; readonly channel: string;
      readonly requestId: string; readonly status: 'error'; readonly pane: NewarchPaneKey;
      readonly code: NewarchV2HistoryErrorCode; readonly retryAfterMs: number | null };
export function newarchV2SamePane(a: NewarchPaneKey, b: NewarchPaneKey): boolean {
  return a.serverIdentity === b.serverIdentity && a.paneId === b.paneId && a.birthGeneration === b.birthGeneration;
}
/** Client-side invalidation: keep a cursor only for the SAME pane identity
 * (server lifetime + pane id + birth generation). A new session/pane, a reused
 * pane id or a restarted server drops it; never send a stale cursor. */
export function newarchV2CursorFor(pane: NewarchV2PaneDescriptor, cursor: NewarchV2HistoryCursor | null): NewarchV2HistoryCursor | null {
  return cursor && cursor.schema === NEWARCH_V2_SCHEMA && newarchV2SamePane(cursor.pane, pane.pane) ? cursor : null;
}
function newarchV2EntryPane(e: NewarchV2WireEntry): NewarchPaneKey {
  return e.kind === 'row' ? e.id.pane : e.incident.pane;
}
function newarchV2Utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
/** Same rules as server validateV2ReadRequest for a cursor: same pane, non-empty
 * store/token, token at most NEWARCH_V2_WIRE_LIMITS.cursorBytes UTF-8 bytes. */
function newarchV2CursorInBounds(c: NewarchV2HistoryCursor, pane: NewarchPaneKey): boolean {
  return c.schema === NEWARCH_V2_SCHEMA && newarchV2SamePane(c.pane, pane)
    && typeof c.storeId === 'string' && c.storeId.length > 0 && typeof c.token === 'string' && c.token.length > 0
    && newarchV2Utf8Bytes(c.token) <= NEWARCH_V2_WIRE_LIMITS.cursorBytes
    && Number.isSafeInteger(c.timelineRevision) && c.timelineRevision >= 0;
}
/** Same bounds as server validateV2ReadRequest: 1..wire cap for both limits. */
function newarchV2RequestInBounds(r: NewarchV2HistoryRequest): boolean {
  const L = NEWARCH_V2_WIRE_LIMITS;
  return r.schema === NEWARCH_V2_SCHEMA && (r.direction === 'before' || r.direction === 'after')
    && Number.isSafeInteger(r.maxEntries) && r.maxEntries >= 1 && r.maxEntries <= L.pageEntries
    && Number.isSafeInteger(r.maxBytes) && r.maxBytes >= 1 && r.maxBytes <= L.pageBytes
    && (r.cursor === null || newarchV2CursorInBounds(r.cursor, r.pane));
}
/** Both sides check a reply against the request it answers: same request id,
 * channel and pane. An ok page additionally needs a request within the wire
 * caps; at most min(request, wire cap) entries/bytes; every entry/cursor on that
 * pane with cursor tokens <= cursorBytes; revision not behind the cursor it was
 * asked with; and storage/remote unavailable is never `end` in the requested
 * direction (it is `blocked`). An error reply may answer an out-of-bounds
 * request (that is what `bounded-read` is for). */
export function newarchV2ReplyMatches(message: NewarchV2HistoryExpandMessage, reply: NewarchV2HistoryReply): boolean {
  const req = message.request;
  if (reply.schema !== NEWARCH_V2_SCHEMA || reply.type !== 'history_v2' || req.schema !== NEWARCH_V2_SCHEMA
    || reply.requestId !== message.requestId || reply.channel !== message.session
    || !newarchV2SamePane(reply.pane, req.pane)) return false;
  if (reply.status === 'error') return true;
  if (!newarchV2RequestInBounds(req)) return false;
  const L = NEWARCH_V2_WIRE_LIMITS, minRevision = req.cursor ? req.cursor.timelineRevision : 0;
  const ahead = req.direction === 'before' ? reply.before : reply.after;
  const unavailable = reply.states.some(s => s.kind === 'storage-unavailable' || s.kind === 'remote-unavailable');
  return Number.isSafeInteger(reply.revision) && reply.revision >= minRevision
    && Number.isSafeInteger(reply.payloadBytes) && reply.payloadBytes >= 0
    && reply.entries.length <= Math.min(req.maxEntries, L.pageEntries)
    && reply.payloadBytes <= Math.min(req.maxBytes, L.pageBytes)
    && reply.entries.every(e => newarchV2SamePane(newarchV2EntryPane(e), req.pane))
    && [reply.before, reply.after].every(c => c.kind === 'end' || newarchV2CursorInBounds(c.cursor, req.pane))
    && !(unavailable && ahead.kind === 'end');
}
