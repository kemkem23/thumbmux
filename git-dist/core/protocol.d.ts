/**
 * thumbmux WS protocol — the message shapes exchanged between the browser
 * mux client (thumbmux/svelte ws-mux) and the server mux (thumbmux/server).
 * One connection multiplexes many sessions; `channel` = session name, with
 * the reserved `__sessions` channel carrying session-list pushes.
 */
export type MuxCursor = {
    row: number;
    col: number;
};
/** tmux pane screen-mode sample: alternate buffer + SGR / any-event mouse. */
export interface MuxPaneScreen {
    /** Authoritative durable preview state; absent for legacy live captures. */
    previewState?: "live" | "orphaned" | "ended" | "unavailable";
    previewHasFrame?: boolean;
    /** Timestamp of the last WAL record backing this verified preview. */
    previewLastSuccessfulAt?: number;
    alt: boolean;
    mouseSgr: boolean;
    mouseAny: boolean;
}
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
export type MuxHistoryBoundaryTransition = "same" | "advance" | "regression" | "generation-mismatch";
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
    paneKey: {
        serverIdentity: string;
        paneId: string;
        birthGeneration: number;
    };
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
    markers: Array<{
        lineId: number | null;
        kind: string;
        missingCount: number | null;
    }>;
};
/** Parse and defensively clone a newarch-frame-v1 descriptor; null when malformed. */
export declare function validateNewarchFrameMeta(value: unknown): NewarchFrameMeta | null;
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
export declare const HISTORY_PAGE_MARKER_LIMIT = 64;
/**
 * Parse and defensively clone a history page's `markers`. `undefined` (a
 * legacy page) is an empty list; anything malformed or over the limit is null
 * so a caller never draws a guessed position.
 */
export declare function validateHistoryPageMarkers(value: unknown): MuxHistoryPageMarker[] | null;
/** A delta carrying `next` may apply on a base described by `base`. */
export declare function newarchDeltaContinues(base: NewarchFrameMeta, next: NewarchFrameMeta): boolean;
export type MuxOutputFrame = MuxFullOutputFrame | MuxDeltaFrame;
export type MuxResyncRequest = {
    type: "resync";
    session: string;
};
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
export type MuxStrictClientMessage = MuxResyncRequest
/** NEWARCH v2 history read (Q22 flag-on K-r1, additive); legacy `history_expand` is unchanged. */
 | NewarchV2HistoryExpandMessage | {
    type: "ping";
    client?: unknown;
} | {
    type: "client_info";
    client?: unknown;
} | {
    type: "subscribe" | "unsubscribe";
    session: string;
    tail?: number;
    delta?: boolean;
    client?: unknown;
} | {
    type: "keys";
    session: string;
    data: string;
    client?: unknown;
} | {
    type: "resize";
    session: string;
    cols: number;
    rows: number;
    client?: unknown;
} | {
    type: "sessions_subscribe" | "sessions_unsubscribe";
    client?: unknown;
} | {
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
export type MuxPongFrame = {
    type: "pong";
};
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
export declare function splitMuxOutputData(data: string): string[];
/**
 * Portable lowercase FNV-1a-32 over the UTF-8 bytes of a string.
 * Indexed loop (not for-of) — for-of on Uint8Array allocates an iterator
 * result object per byte and was the dominant cost on ~348 KB delta bases.
 */
export declare function fnv1a32(value: string): string;
/** The required prefix hash for a raw output-line base. */
export declare function muxPrefixHash(lines: readonly string[]): string;
/** Count equal raw lines from the beginning of two output bases. */
export declare function muxCommonPrefixLength(base: readonly string[], next: readonly string[]): number;
/** Build a complete replacement-suffix delta. */
export declare function createMuxDeltaFrame(channel: string, base: readonly string[], next: readonly string[], cursor?: MuxCursor | null): MuxDeltaFrame;
/** Parse and defensively clone a durable seam identity received from the wire. */
export declare function validateMuxHistoryBoundary(value: unknown): MuxHistoryBoundary | null;
/** Classify an incoming seam relative to the last accepted seam. */
export declare function muxHistoryBoundaryTransition(previous: MuxHistoryBoundary, next: MuxHistoryBoundary): MuxHistoryBoundaryTransition;
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
/** Opt-in flag-on extension; legacy frame/page payloads keep their v1 meaning.
 * Negotiate every required capability before sending this envelope. Unknown
 * versions are unsupported, never an empty page. Counts/offsets are safe uints.
 */
export declare const NEWARCH_HISTORY_EXTENSION_VERSION: 1;
export declare const NEWARCH_FLAGON_CAPABILITIES: readonly ["stitch-v1", "capture-v1", "spool-v1", "receipt-v1", "bundle-v1", "catalog-v3", "history-states-v1"];
export type NewarchFlagOnCapability = typeof NEWARCH_FLAGON_CAPABILITIES[number];
export interface NewarchCapabilities {
    readonly extensionVersion: 1;
    readonly supported: readonly NewarchFlagOnCapability[];
    readonly required: readonly NewarchFlagOnCapability[];
}
export interface NewarchPaneKey {
    readonly serverIdentity: string;
    readonly paneId: string;
    readonly birthGeneration: number;
}
/** Segment coordinates are NOT legacy global lineId or capture rowIndex. */
export interface NewarchRowId {
    readonly pane: NewarchPaneKey;
    readonly segmentId: string;
    readonly rowOrdinal: number;
}
export interface NewarchRowRange {
    readonly pane: NewarchPaneKey;
    readonly segmentId: string;
    readonly start: number;
    readonly end: number;
}
export type NewarchMissingCount = {
    readonly countKind: 'unknown';
    readonly missingCount: null;
} | {
    readonly countKind: 'exact' | 'estimate';
    readonly missingCount: number;
};
export type NewarchGap = NewarchMissingCount & {
    readonly version: 1;
    readonly episodeId: string;
    readonly parentEpisodeId: string | null;
    readonly pane: NewarchPaneKey;
    readonly leftRowId: NewarchRowId | null;
    readonly rightSegmentId: string | null;
    readonly reason: 'pipe-eof' | 'collector-exit' | 'ambiguous-overlap' | 'unproven-overlap' | 'unknown-vt-state' | 'interrupted-capture' | 'storage-outage' | 'corruption' | 'identity-change' | 'geometry-change' | 'ownership-lost' | 'visible-divergence';
    readonly withheldRows: number;
    readonly lowerBound: number;
    readonly openedAt: number;
    readonly closedAt: number | null;
    readonly clockEpoch: string;
    readonly quality: 'degraded' | 'resolved';
};
/** Opaque serialized token. Only H/A mint/validate it; D must not do arithmetic. */
export interface NewarchHistoryCursor {
    readonly version: 1;
    readonly token: string;
}
export type NewarchHistoryState = {
    readonly kind: 'exact';
} | {
    readonly kind: 'gap';
    readonly gap: NewarchGap;
} | {
    readonly kind: 'pending';
    readonly operationId: string;
    readonly retryAfterMs: number;
} | {
    readonly kind: 'remote-required';
    readonly range: NewarchRowRange;
    readonly bundleId: string;
} | {
    readonly kind: 'remote-unavailable';
    readonly range: NewarchRowRange;
    readonly bundleId: string;
    readonly retryAfterMs: number;
    readonly reason: 'offline' | 'missing' | 'corrupt';
} | {
    readonly kind: 'degraded';
    readonly episodeId: string;
    readonly uncertainFields: readonly string[];
} | {
    readonly kind: 'pressure';
    readonly level: 'archive' | 'critical' | 'emergency';
    readonly collecting: boolean;
    readonly sinceMonoMs: number;
};
/** Status is separate from terminal text: copy/search must never include labels.
 * Only end proves EOF. blocked always retains a continuation and readable prefix.
 */
export type NewarchHistoryContinuation = {
    readonly kind: 'end';
} | {
    readonly kind: 'more';
    readonly cursor: NewarchHistoryCursor;
} | {
    readonly kind: 'blocked';
    readonly cursor: NewarchHistoryCursor;
    readonly state: Exclude<NewarchHistoryState, {
        readonly kind: 'exact';
    }>;
};
export interface NewarchHistoryExtension {
    readonly version: 1;
    readonly capabilities: NewarchCapabilities;
    readonly states: readonly NewarchHistoryState[];
    readonly before: NewarchHistoryContinuation;
    readonly after: NewarchHistoryContinuation;
}
/** Repair capabilities are a separate tagged envelope. Do not advertise them
 * in the v1 list: an old consumer must reject r2, not reinterpret old bytes. */
export declare const NEWARCH_REPAIR_CAPABILITIES: readonly ["cell-sgr-r2", "digest-provenance-r2", "attach-receipt-set-r2", "timeline-replay-r2", "spool-retention-r2", "archive-inventory-r2", "same-pipe-return-r2", "incident-r2"];
export type NewarchRepairCapability = typeof NEWARCH_REPAIR_CAPABILITIES[number];
export interface NewarchRepairCapabilities {
    readonly revision: 2;
    readonly supported: readonly NewarchRepairCapability[];
    readonly required: readonly NewarchRepairCapability[];
}
/** Unknown revision/capability is unsupported. Both peers' requirements count. */
export declare function supportsNewarchRepair(local: NewarchRepairCapabilities, peer: {
    readonly revision: number;
    readonly supported: readonly string[];
    readonly required: readonly string[];
}): boolean;
export interface NewarchGapIdentityR2 {
    readonly revision: 2;
    readonly gapId: string;
    readonly sequence: number;
    readonly update: number;
    readonly state: 'open' | 'closed';
}
export type NewarchGapR2 = NewarchGap & {
    readonly repair: NewarchGapIdentityR2;
};
export interface NewarchIncidentR2 {
    readonly revision: 2;
    readonly incidentId: string;
    readonly pane: NewarchPaneKey;
    readonly leftRowId: NewarchRowId | null;
    readonly openedAtWallMs: number;
    readonly openedAtMonoMs: number;
    readonly clockEpoch: string;
    readonly collecting: boolean;
    readonly reason: 'storage-outage' | 'collector-stalled' | 'collector-exit' | 'io';
    readonly quality: 'degraded' | 'resolved';
    readonly resolvedAtWallMs: number | null;
}
export type NewarchPressureR2 = Extract<NewarchHistoryState, {
    readonly kind: 'pressure';
}> & {
    readonly repair: NewarchIncidentR2;
};
export type NewarchHistoryStateR2 = Exclude<NewarchHistoryState, {
    readonly kind: 'pressure';
} | {
    readonly kind: 'gap';
}> | NewarchPressureR2 | {
    readonly kind: 'gap';
    readonly gap: NewarchGapR2;
};
export type NewarchHistoryContinuationR2 = {
    readonly kind: 'end';
} | {
    readonly kind: 'more';
    readonly cursor: NewarchHistoryCursor;
} | {
    readonly kind: 'blocked';
    readonly cursor: NewarchHistoryCursor;
    readonly state: Exclude<NewarchHistoryStateR2, {
        readonly kind: 'exact';
    }>;
};
export interface NewarchHistoryRepairR2 extends NewarchHistoryExtension {
    readonly repair: NewarchRepairCapabilities;
    readonly states: readonly NewarchHistoryStateR2[];
    readonly before: NewarchHistoryContinuationR2;
    readonly after: NewarchHistoryContinuationR2;
}
/** Q22 / PLAN-v2. This is NOT the repair-r2 envelope above. Never infer v2
 * support from flag-on/repair support. D/U negotiate before sending these
 * messages; old clients may read legacy panes but cannot resize v2 panes. */
export declare const NEWARCH_V2_SCHEMA: "newarch-v2";
export declare const NEWARCH_V2_CAPABILITIES: readonly ["permanent-capture-owner", "fixed-geometry", "pane-history-cursor", "durable-incidents", "live-checkpoint", "bounded-audit"];
export interface NewarchV2Capabilities {
    readonly schema: typeof NEWARCH_V2_SCHEMA;
    readonly supported: readonly string[];
    readonly required: readonly string[];
}
export declare function supportsNewarchV2(local: NewarchV2Capabilities, peer: NewarchV2Capabilities): boolean;
/** Session UUID is minted and persisted before birth, never a display name,
 * tmux numeric session id or PID. serverIdentity changes on server recreation. */
export interface NewarchV2SessionKey {
    readonly serverIdentity: string;
    readonly sessionId: string;
}
export interface NewarchV2FixedGeometry {
    readonly policy: 'fixed-at-birth';
    readonly columns: number;
    readonly rows: number;
    readonly configVersion: string;
    readonly panesPerWindow: 1;
}
export type NewarchV2PaneState = 'reserved' | 'active' | 'stopped' | 'closed' | 'unrecorded';
export interface NewarchV2PaneDescriptor {
    readonly schema: typeof NEWARCH_V2_SCHEMA;
    readonly session: NewarchV2SessionKey;
    readonly pane: NewarchPaneKey;
    readonly windowId: string;
    readonly owner: 'capture-engine';
    readonly birthOperationId: string;
    readonly geometry: NewarchV2FixedGeometry;
    readonly state: NewarchV2PaneState;
}
export type NewarchV2PaneSelection = {
    readonly kind: 'selected';
    readonly pane: NewarchV2PaneDescriptor;
} | {
    readonly kind: 'ambiguous';
    readonly panes: readonly NewarchV2PaneDescriptor[];
    readonly next: string | null;
} | {
    readonly kind: 'missing';
} | {
    readonly kind: 'owner-unavailable';
    readonly retryAfterMs: number;
};
export type NewarchV2IncidentReason = 'geometry-violation' | 'unverified-restart' | 'unrecorded-birth' | 'birth-failed' | 'pipe-eof' | 'collector-epoch-changed' | 'storage-outage' | 'budget-exhausted' | 'audit-mismatch' | 'decoder-anomaly' | 'identity-change';
/** Timeline positions, not legacy line numbers. null is before the first row.
 * affected.to=null is open-ended; annotate published rows from last proof,
 * not merely the tail at detection time. Unknown loss is never zero. */
export interface NewarchV2Incident {
    readonly schema: typeof NEWARCH_V2_SCHEMA;
    readonly incidentId: string;
    readonly pane: NewarchPaneKey;
    readonly reason: NewarchV2IncidentReason;
    readonly frontier: NewarchRowId | null;
    readonly affected: {
        readonly after: NewarchRowId | null;
        readonly through: NewarchRowId | null;
    };
    readonly openedAtWallMs: number;
    readonly openedAtMonoMs: number;
    readonly clockEpoch: string;
    readonly collecting: boolean;
    readonly missing: NewarchMissingCount;
    readonly ruleVersion: string;
    readonly configVersion: string;
    readonly geometry: NewarchV2FixedGeometry;
    readonly revision: number;
    readonly sourceEpoch: NewarchV2SourceEpoch | null;
    readonly sourceOffset: number | null;
    readonly expectedDigest: string | null;
    readonly actualDigest: string | null;
    readonly action: 'gap-and-stop' | 'annotate' | 'repair-pending';
    readonly evidence: {
        readonly digest: string;
        readonly bytes: number;
        readonly redacted: true;
    } | null;
}
/** H mints/validates token and binds it to pane/store/timeline revision. Token
 * is opaque, <=4096 UTF-8 bytes. Segment migration MUST NOT change coordinates.
 * Same cursor survives restart; missing/corrupt remote is blocked, never end. */
export interface NewarchV2HistoryCursor {
    readonly schema: typeof NEWARCH_V2_SCHEMA;
    readonly pane: NewarchPaneKey;
    readonly storeId: string;
    readonly timelineRevision: number;
    readonly token: string;
}
export type NewarchV2ReadState = {
    readonly kind: 'exact';
    readonly auditedRevision: number | null;
} | {
    readonly kind: 'incident';
    readonly incident: NewarchV2Incident;
} | {
    readonly kind: 'storage-unavailable';
    readonly pendingIncidentId: string | null;
    readonly retryAfterMs: number;
} | {
    readonly kind: 'remote-unavailable';
    readonly bundleId: string;
    readonly reason: 'offline' | 'missing' | 'corrupt';
    readonly retryAfterMs: number;
};
export type NewarchV2Continuation = {
    readonly kind: 'end';
} | {
    readonly kind: 'more';
    readonly cursor: NewarchV2HistoryCursor;
} | {
    readonly kind: 'blocked';
    readonly cursor: NewarchV2HistoryCursor;
    readonly state: Extract<NewarchV2ReadState, {
        readonly kind: 'storage-unavailable' | 'remote-unavailable';
    }>;
};
/** No server resize request is implied by viewport/font/fit-to-width changes.
 * D/U use horizontal scrolling by default, no history rewrap. Labels are UI
 * text outside copy/search content, including incidents when no live pane. */
export interface NewarchV2FrameMeta {
    readonly schema: typeof NEWARCH_V2_SCHEMA;
    readonly pane: NewarchV2PaneDescriptor;
    readonly revision: number;
    readonly durableRevision: number;
    readonly sourceEpoch: NewarchV2SourceEpoch;
    readonly state: NewarchV2ReadState;
}
export interface NewarchV2HistoryRequest {
    readonly schema: typeof NEWARCH_V2_SCHEMA;
    readonly pane: NewarchPaneKey;
    readonly cursor: NewarchV2HistoryCursor | null;
    readonly direction: 'before' | 'after';
    readonly maxEntries: number;
    readonly maxBytes: number;
}
export interface NewarchV2GeometryReply {
    readonly schema: typeof NEWARCH_V2_SCHEMA;
    readonly pane: NewarchPaneKey;
    readonly status: 'fixed';
    readonly geometry: NewarchV2FixedGeometry;
}
/** D/I add these to the negotiated transport; v1 frames are not reinterpreted.
 * Delta bases must match pane, sourceEpoch, fixed geometry and not regress
 * revision. Identity/geometry changes require a full reset. */
export type NewarchV2OutputFrame = (Omit<MuxFullOutputFrame, 'newarch'> | Omit<MuxDeltaFrame, 'newarch'>) & {
    readonly newarchV2: NewarchV2FrameMeta;
};
/** Immutable collector incarnation + attachment, never host receive order. */
export interface NewarchV2SourceEpoch {
    readonly attachId: string;
    readonly collectorIncarnation: string;
}
/** Q22 flag-on (K, 2026-10-05): v2 history request/reply on the mux socket.
 * Additive and separate from `history_expand`/`history` (legacy line anchors):
 * legacy clients never see these frames and a v2 cursor is never flattened to
 * a line number. D3 wires them; D1 answers from H through NewarchV2Display.
 * Numbers mirror NEWARCH_V2_LIMITS (server) and are asserted equal by K. */
export declare const NEWARCH_V2_WIRE_LIMITS: Readonly<{
    readonly pageEntries: 256;
    readonly pageBytes: number;
    readonly cursorBytes: 4096;
}>;
/** Screen projection of a committed row: provenance (cellOrigins) stays server-side. */
export interface NewarchV2WireCell {
    readonly text: string;
    readonly width: 0 | 1 | 2;
    readonly style: readonly number[];
}
export interface NewarchV2WireRow {
    readonly kind: 'row';
    readonly id: NewarchRowId;
    readonly cells: readonly NewarchV2WireCell[];
    readonly wrapStatus: 'wrapped' | 'unwrapped' | 'unknown';
    readonly wrapPad: number;
}
export type NewarchV2WireEntry = NewarchV2WireRow | {
    readonly kind: 'incident';
    readonly incident: NewarchV2Incident;
};
/** Client -> server. requestId is client-chosen, echoed verbatim. */
export interface NewarchV2HistoryExpandMessage {
    readonly type: 'history_expand_v2';
    readonly session: string;
    readonly requestId: string;
    readonly request: NewarchV2HistoryRequest;
}
export type NewarchV2HistoryErrorCode = 'wrong-pane' | 'stale-cursor' | 'bounded-read' | 'owner-unavailable' | 'unsupported';
/** Server -> client. Entries are ascending timeline order in either direction.
 * An error is never an empty ok page; blocked continuation is never `end`. */
export type NewarchV2HistoryReply = {
    readonly schema: typeof NEWARCH_V2_SCHEMA;
    readonly type: 'history_v2';
    readonly channel: string;
    readonly requestId: string;
    readonly status: 'ok';
    readonly pane: NewarchPaneKey;
    readonly revision: number;
    readonly entries: readonly NewarchV2WireEntry[];
    readonly payloadBytes: number;
    readonly states: readonly NewarchV2ReadState[];
    readonly before: NewarchV2Continuation;
    readonly after: NewarchV2Continuation;
} | {
    readonly schema: typeof NEWARCH_V2_SCHEMA;
    readonly type: 'history_v2';
    readonly channel: string;
    readonly requestId: string;
    readonly status: 'error';
    readonly pane: NewarchPaneKey;
    readonly code: NewarchV2HistoryErrorCode;
    readonly retryAfterMs: number | null;
};
export declare function newarchV2SamePane(a: NewarchPaneKey, b: NewarchPaneKey): boolean;
/** Client-side invalidation: keep a cursor only for the SAME pane identity
 * (server lifetime + pane id + birth generation). A new session/pane, a reused
 * pane id or a restarted server drops it; never send a stale cursor. */
export declare function newarchV2CursorFor(pane: NewarchV2PaneDescriptor, cursor: NewarchV2HistoryCursor | null): NewarchV2HistoryCursor | null;
/** Both sides check a reply against the request it answers: same request id,
 * channel and pane. An ok page additionally needs a request within the wire
 * caps; at most min(request, wire cap) entries/bytes; every entry/cursor on that
 * pane with cursor tokens <= cursorBytes; revision not behind the cursor it was
 * asked with; and storage/remote unavailable is never `end` in the requested
 * direction (it is `blocked`). An error reply may answer an out-of-bounds
 * request (that is what `bounded-read` is for). */
export declare function newarchV2ReplyMatches(message: NewarchV2HistoryExpandMessage, reply: NewarchV2HistoryReply): boolean;
