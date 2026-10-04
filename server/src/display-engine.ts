import {
  NEWARCH_FLAGON_CAPABILITIES,
  NEWARCH_REPAIR_CAPABILITIES,
  NEWARCH_V2_SCHEMA,
  type NewarchCapabilities,
  type NewarchFlagOnCapability,
  type NewarchGap,
  type NewarchHistoryContinuation,
  type NewarchHistoryExtension,
  type NewarchHistoryState,
  type NewarchPaneKey,
  type NewarchV2FixedGeometry,
  type NewarchV2GeometryReply,
  type NewarchV2HistoryRequest,
  type NewarchV2PaneDescriptor,
  type NewarchV2PaneSelection,
  type NewarchV2ReadState,
  type NewarchV2SessionKey,
} from "@thumbmux/core";
import {
  NEWARCH_V2_VERSION,
  STREAM_BUDGET,
  validReadOpen,
  validateV2Incident,
  validateV2ReadRequest,
  type CancelToken,
  type CaptureEngine,
  type CommittedStreamRow,
  type DisplayEngine,
  type HistoryEngine,
  type HistoryPage,
  type LiveFrame,
  type PageCursor,
  type ReadOpenAck,
  type ReadRequest,
  type ReadView,
  type Result,
  type StreamFailure,
  type StreamIdentity,
  type StreamObserver,
  type V2HistoryPage,
  type V2HistoryReader,
  type V2WriteCommand,
  type ViewerRoute,
} from "./stream-contract";

type Release = () => void;

export interface DisplayEngineOptions {
  /** Stream runtime opt-in: contention may use the full request deadline. */
  readonly retryUntilDeadline?: boolean;
  readonly capture: CaptureEngine;
  readonly history: HistoryEngine;
  readonly observer?: StreamObserver;
  readonly now?: () => number;
  /**
   * Flag-on display negotiation. Absent: a page carrying a flag-on envelope is
   * refused as unsupported (never shown as a legacy page that ends in EOF).
   * `required`: every page must carry the envelope; a bare page is an
   * integrity error because its missing states would read as EOF.
   */
  readonly flagOn?: DisplayFlagOnOptions;
}

export interface DisplayFlagOnOptions {
  readonly supported: readonly NewarchFlagOnCapability[];
  readonly required: boolean;
}

export interface DisplayEngineStats {
  readonly attachedViewers: number;
  readonly pagePoolBytes: number;
  readonly pageBytesByViewer: Readonly<Record<string, number>>;
  readonly wsPendingBytes: number;
  readonly wsPendingBytesByViewer: Readonly<Record<string, number>>;
}

/**
 * The integration lot implements this interface without teaching the display
 * engine about WebSocket or the legacy JSON envelope. A caller must reserve
 * the encoded bytes before enqueueing and release them only after the socket
 * has flushed or discarded that item. A null reservation means "send one
 * resync token", never retain another frame.
 */
export interface LegacyDisplayAdapter {
  readonly engine: StreamDisplayEngine;
  attach(route: ViewerRoute, onFrame: (frame: LiveFrame) => void): Promise<Result<LiveFrame>>;
  read(route: ViewerRoute, request: ReadRequest, cursor: PageCursor | null, limit: number, cancel: CancelToken): Promise<Result<HistoryPage>>;
  reserveEncodedBytes(viewerId: string, bytes: number): Release | null;
  detach(route: ViewerRoute, reason: string): Promise<void>;
}

interface Attachment {
  readonly route: ViewerRoute;
  readonly onFrame: (frame: LiveFrame) => void;
  unsubscribe: Release;
  settleInitial: ((result: Result<LiveFrame>) => void) | null;
}

interface PageEntry {
  readonly key: string;
  readonly page: HistoryPage;
  readonly bytes: number;
  usedAt: number;
}

const ok = <T>(value: T): Result<T> => ({ status: "ok", value });
const staleRoute = (): StreamFailure => ({ status: "stale", reason: "route" });
const cancelled = (): StreamFailure => ({ status: "cancelled", reason: "cancelled" });
const deadline = (): StreamFailure => ({ status: "error", code: "deadline", message: "display page deadline exceeded" });

function samePane(a: StreamIdentity["pane"] | undefined, b: StreamIdentity["pane"]): boolean {
  return !!a && a.serverIdentity === b.serverIdentity && a.paneId === b.paneId && a.birthGeneration === b.birthGeneration;
}

function sameIdentity(a: StreamIdentity, b: StreamIdentity): boolean {
  return samePane(a.pane, b.pane)
    && a.sourceEpoch === b.sourceEpoch
    && a.geometryGeneration === b.geometryGeneration;
}

function sameRoute(a: ViewerRoute, b: ViewerRoute): boolean {
  return a.viewerId === b.viewerId && a.routeGeneration === b.routeGeneration && sameIdentity(a.identity, b.identity);
}

function validCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function cloneIdentity(identity: StreamIdentity): StreamIdentity {
  return {
    pane: {
      serverIdentity: identity.pane.serverIdentity,
      paneId: identity.pane.paneId,
      birthGeneration: identity.pane.birthGeneration,
    },
    sourceEpoch: identity.sourceEpoch,
    geometryGeneration: identity.geometryGeneration,
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableFrame(frame: LiveFrame): LiveFrame {
  return deepFreeze({
    identity: cloneIdentity(frame.identity),
    screenRevision: frame.screenRevision,
    buffer: frame.buffer,
    geometry: { ...frame.geometry },
    changedRows: frame.changedRows.map(changed => ({
      y: changed.y,
      content: {
        cells: changed.content.cells.map(cell => ({ text: cell.text, width: cell.width, style: [...cell.style] })),
        softWrap: changed.content.softWrap,
        wrapPad: changed.content.wrapPad,
        uncertainFields: [...changed.content.uncertainFields],
      },
    })),
    cursor: { ...frame.cursor },
    overlap: frame.overlap ? { ...frame.overlap } : null,
    revision: frame.revision,
    durableRevision: frame.durableRevision,
    head: frame.head,
  });
}

function immutableView(view: ReadView): ReadView {
  return deepFreeze({
    requestId: view.requestId,
    identity: cloneIdentity(view.identity),
    routeGeneration: view.routeGeneration,
    range: { ...view.range },
    deadlineMonoMs: view.deadlineMonoMs,
    grantRevision: view.grantRevision,
    durableAtGrant: view.durableAtGrant,
    headAtGrant: view.headAtGrant,
    overlayHandle: view.overlayHandle,
    ...(view.flagOn ? { flagOn: structuredClone(view.flagOn) } : {}),
  });
}

function immutablePage(page: HistoryPage): HistoryPage {
  const view = immutableView(page.view);
  return deepFreeze({
    view,
    fragments: page.fragments.map(fragment => ({
      row: {
        id: { pane: { ...fragment.row.id.pane }, lineId: fragment.row.id.lineId },
        revision: fragment.row.revision,
        source: {
          pane: { ...fragment.row.source.pane }, sourceEpoch: fragment.row.source.sourceEpoch,
          packetSeq: fragment.row.source.packetSeq, scrollOrdinal: fragment.row.source.scrollOrdinal,
        },
        geometryGeneration: fragment.row.geometryGeneration,
        geometry: { ...fragment.row.geometry },
        cells: fragment.row.cells.map(cell => ({ text: cell.text, width: cell.width, style: [...cell.style] })),
        softWrap: fragment.row.softWrap,
        wrapPad: fragment.row.wrapPad,
        uncertainFields: [...fragment.row.uncertainFields],
      },
      startCell: fragment.startCell,
      endCell: fragment.endCell,
      complete: fragment.complete,
    })),
    payloadBytes: page.payloadBytes,
    nextBefore: page.nextBefore ? { ...page.nextBefore } : null,
    nextAfter: page.nextAfter ? { ...page.nextAfter } : null,
    hasMoreBefore: page.hasMoreBefore,
    hasMoreAfter: page.hasMoreAfter,
    // Status travels beside the rows, never inside a fragment's cells.
    ...(page.flagOn ? { flagOn: structuredClone(page.flagOn) } : {}),
  });
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(NEWARCH_FLAGON_CAPABILITIES);
const REPAIR_CAPABILITIES: ReadonlySet<string> = new Set(NEWARCH_REPAIR_CAPABILITIES);
const INCIDENT_REASONS: ReadonlySet<string> = new Set([
  "storage-outage", "collector-stalled", "collector-exit", "io",
]);
const GAP_REASONS: ReadonlySet<string> = new Set<NewarchGap["reason"]>([
  "pipe-eof", "collector-exit", "ambiguous-overlap", "unproven-overlap", "unknown-vt-state",
  "interrupted-capture", "storage-outage", "corruption", "identity-change", "geometry-change",
  "ownership-lost", "visible-divergence",
]);

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validCapabilities(value: NewarchCapabilities): NewarchCapabilities | null {
  if (value?.extensionVersion !== 1 || !Array.isArray(value.supported) || !Array.isArray(value.required)) return null;
  const all = [...value.supported, ...value.required];
  if (!all.every(cap => typeof cap === "string" && KNOWN_CAPABILITIES.has(cap))) return null;
  if (!value.supported.includes("history-states-v1") || !value.required.every(cap => value.supported.includes(cap))) return null;
  return value;
}

function validRange(range: { pane: NewarchPaneKey; segmentId: string; start: number; end: number }, pane: NewarchPaneKey): boolean {
  return samePane(range?.pane, pane) && typeof range.segmentId === "string"
    && validCounter(range.start) && validCounter(range.end) && range.start <= range.end;
}

/** Unknown is null, never 0; a gap names this pane only. */
function validGap(gap: NewarchGap, pane: NewarchPaneKey): boolean {
  if (gap?.version !== 1 || !validText(gap.episodeId) || !samePane(gap.pane, pane) || !GAP_REASONS.has(gap.reason)) return false;
  if (gap.parentEpisodeId !== null && !validText(gap.parentEpisodeId)) return false;
  if (gap.rightSegmentId !== null && typeof gap.rightSegmentId !== "string") return false;
  if (gap.leftRowId !== null && (!samePane(gap.leftRowId.pane, pane) || typeof gap.leftRowId.segmentId !== "string"
    || !validCounter(gap.leftRowId.rowOrdinal))) return false;
  if (gap.countKind === "unknown") { if (gap.missingCount !== null) return false; }
  else if (gap.countKind === "exact" || gap.countKind === "estimate") { if (!validCounter(gap.missingCount)) return false; }
  else return false;
  return validCounter(gap.withheldRows) && validCounter(gap.lowerBound)
    && Number.isFinite(gap.openedAt) && (gap.closedAt === null || Number.isFinite(gap.closedAt))
    && typeof gap.clockEpoch === "string" && (gap.quality === "degraded" || gap.quality === "resolved");
}

function validHistoryState(state: NewarchHistoryState, pane: NewarchPaneKey): boolean {
  switch (state?.kind) {
    case "exact": return true;
    case "gap": return validGap(state.gap, pane);
    case "pending": return validText(state.operationId) && validCounter(state.retryAfterMs);
    case "remote-required": return validRange(state.range, pane) && validText(state.bundleId);
    case "remote-unavailable":
      return validRange(state.range, pane) && validText(state.bundleId) && validCounter(state.retryAfterMs)
        && (state.reason === "offline" || state.reason === "missing" || state.reason === "corrupt");
    case "degraded":
      return validText(state.episodeId) && Array.isArray(state.uncertainFields)
        && state.uncertainFields.every(field => typeof field === "string");
    case "pressure":
      return (state.level === "archive" || state.level === "critical" || state.level === "emergency")
        && typeof state.collecting === "boolean" && Number.isFinite(state.sinceMonoMs) && state.sinceMonoMs >= 0;
    default: return false;
  }
}

function validRepairCapabilities(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const repair = value as { revision?: unknown; supported?: unknown; required?: unknown };
  if (repair.revision !== 2 || !Array.isArray(repair.supported) || !Array.isArray(repair.required)) return false;
  const names = [...repair.supported, ...repair.required];
  if (!names.every(cap => typeof cap === "string" && REPAIR_CAPABILITIES.has(cap))) return false;
  return repair.required.every(cap => (repair.supported as readonly unknown[]).includes(cap));
}

function validIncident(value: unknown, collecting: boolean, pane: NewarchPaneKey): boolean {
  if (!value || typeof value !== "object") return false;
  const incident = value as Record<string, unknown>;
  if (incident.revision !== 2 || !validText(incident.incidentId) || !samePane(incident.pane as NewarchPaneKey, pane)) return false;
  if (!("leftRowId" in incident)) return false;
  if (incident.leftRowId !== null) {
    const left = incident.leftRowId as { pane?: NewarchPaneKey; segmentId?: unknown; rowOrdinal?: unknown };
    if (!samePane(left?.pane, pane) || !validText(left?.segmentId) || !validCounter(left?.rowOrdinal as number)) return false;
  }
  if (!validCounter(incident.openedAtWallMs as number) || !validCounter(incident.openedAtMonoMs as number)) return false;
  if (!validText(incident.clockEpoch)) return false;
  if (incident.collecting !== collecting) return false;
  if (typeof incident.reason !== "string" || !INCIDENT_REASONS.has(incident.reason)) return false;
  if (incident.quality !== "degraded" && incident.quality !== "resolved") return false;
  if (!("resolvedAtWallMs" in incident)) return false;
  return incident.resolvedAtWallMs === null || validCounter(incident.resolvedAtWallMs as number);
}

/** A repair claim without incident id, wall time, and last row is not a stop label. */
function validPressureStop(state: NewarchHistoryState, pane: NewarchPaneKey, repairClaimed: boolean): boolean {
  if (state.kind !== "pressure") return true;
  const incident = (state as { repair?: unknown }).repair;
  if (!repairClaimed) return incident === undefined;
  return validIncident(incident, state.collecting, pane);
}

function validContinuation(continuation: NewarchHistoryContinuation, pane: NewarchPaneKey): boolean {
  if (continuation?.kind === "end") return true;
  if (continuation?.kind !== "more" && continuation?.kind !== "blocked") return false;
  // Opaque: only H/A mint and read it; D checks shape, never does arithmetic.
  if (continuation.cursor?.version !== 1 || !validText(continuation.cursor.token)) return false;
  return continuation.kind === "more"
    || (continuation.state?.kind !== ("exact" as string) && validHistoryState(continuation.state, pane));
}

type WaitResult<T> = { readonly kind: "value"; readonly value: T }
  | { readonly kind: "failure"; readonly failure: StreamFailure }
  | { readonly kind: "throw" };

export class StreamDisplayEngine implements DisplayEngine {
  private readonly capture: CaptureEngine;
  private readonly retryUntilDeadline: boolean;
  private readonly history: HistoryEngine;
  private readonly observer: StreamObserver | undefined;
  private readonly now: () => number;
  private readonly flagOn: DisplayFlagOnOptions | undefined;
  private readonly attachments = new Map<string, Attachment>();
  private readonly pages = new Map<string, PageEntry[]>();
  private readonly pageBytes = new Map<string, number>();
  private pagePoolBytes = 0;
  private readonly wsBytes = new Map<string, number>();
  // Tokens live only while bytes are reserved. Object identity fences late callbacks
  // without retaining viewer tombstones or wrapping a generation counter.
  private readonly wsEpoch = new Map<string, object>();
  private wsPendingBytes = 0;

  constructor(options: DisplayEngineOptions) {
    this.retryUntilDeadline = options.retryUntilDeadline ?? false;
    this.capture = options.capture;
    this.history = options.history;
    this.observer = options.observer;
    this.now = options.now ?? (() => performance.now());
    this.flagOn = options.flagOn
      ? deepFreeze({ supported: [...options.flagOn.supported], required: options.flagOn.required })
      : undefined;
  }

  async attach(route: ViewerRoute, onFrame: (frame: LiveFrame) => void): Promise<Result<LiveFrame>> {
    if (!route.viewerId || !validCounter(route.routeGeneration)
      || !validCounter(route.identity.sourceEpoch) || !validCounter(route.identity.geometryGeneration)
      || !validCounter(route.identity.pane.birthGeneration)) {
      return { status: "error", code: "integrity", message: "invalid display route" };
    }
    const previous = this.attachments.get(route.viewerId);
    if (previous) {
      this.removeAttachment(previous, staleRoute());
      this.clearViewerPages(route.viewerId);
      this.clearViewerWs(route.viewerId);
    }

    return await new Promise<Result<LiveFrame>>(resolve => {
      const attachment: Attachment = {
        route: deepFreeze({ ...route, identity: cloneIdentity(route.identity) }),
        onFrame,
        unsubscribe: () => {},
        settleInitial: resolve,
      };
      this.attachments.set(route.viewerId, attachment);
      attachment.unsubscribe = this.capture.subscribe(route.identity.pane, frame => {
        if (this.attachments.get(route.viewerId) !== attachment || !sameIdentity(frame.identity, route.identity)) return;
        const frozen = immutableFrame(frame);
        const settle = attachment.settleInitial;
        attachment.settleInitial = null;
        if (settle) settle(ok(frozen));
        try {
          attachment.onFrame(frozen);
        } catch (error) {
          this.observer?.record({
            kind: "lifecycle", identity: route.identity, atMonoMs: this.now(),
            reason: "display-listener-error", errorStack: error instanceof Error ? error.stack ?? error.message : String(error),
          });
        }
      });
    });
  }

  async page(
    route: ViewerRoute,
    request: ReadRequest,
    cursor: PageCursor | null,
    limit: number,
    cancel: CancelToken,
  ): Promise<Result<HistoryPage>> {
    if (!this.routeIsCurrent(route) || !sameIdentity(route.identity, request.identity)
      || route.routeGeneration !== request.routeGeneration) return staleRoute();
    if (!this.validRequest(request, cursor, limit)) {
      return { status: "error", code: "integrity", message: "invalid display read request" };
    }
    if (cancel.isCancelled()) return cancelled();
    if (this.now() >= request.deadlineMonoMs) return deadline();

    this.recordRequest(request, "pending", null);
    let view: ReadView | null = null;
    let releaseReason = "page-complete";
    try {
      const granted = await this.callWithRetry(() => this.history.grantReadView(request), request.deadlineMonoMs, cancel, route);
      if (granted.status !== "ok") {
        releaseReason = this.failureReason(granted);
        this.recordRequest(request, this.metricOutcome(granted), this.now());
        return granted;
      }
      view = granted.value;
      if (!sameIdentity(view.identity, route.identity) || view.routeGeneration !== route.routeGeneration
        || view.requestId !== request.requestId) {
        releaseReason = "invalid-grant";
        const failure: StreamFailure = { status: "error", code: "integrity", message: "history granted a mismatched view" };
        this.recordRequest(request, "error", this.now());
        return failure;
      }

      const opened = await this.callWithRetry(() => this.history.openReadView(view!), request.deadlineMonoMs, cancel, route);
      if (opened.status !== "ok") {
        releaseReason = this.failureReason(opened);
        this.recordRequest(request, this.metricOutcome(opened), this.now());
        return opened;
      }
      if (!validReadOpen(opened.value) || !this.sameView(opened.value.view, view)) {
        releaseReason = "invalid-open-fence";
        const failure: StreamFailure = { status: "error", code: "integrity", message: "history opened an invalid read fence" };
        this.recordRequest(request, "error", this.now());
        return failure;
      }

      const read = await this.callWithRetry(
        () => this.history.readPage(opened.value, cursor, limit, this.combinedCancel(cancel, route, request.deadlineMonoMs)),
        request.deadlineMonoMs,
        cancel,
        route,
      );
      if (read.status !== "ok") {
        releaseReason = this.failureReason(read);
        this.recordRequest(request, this.metricOutcome(read), this.now());
        return read;
      }
      if (!this.sameView(read.value.view, view)) {
        releaseReason = "page-view-mismatch";
        const failure: StreamFailure = { status: "error", code: "integrity", message: "history returned a page from another view" };
        this.recordRequest(request, "error", this.now());
        return failure;
      }
      if (!this.validPage(read.value, view)) {
        releaseReason = "invalid-page";
        const failure: StreamFailure = { status: "error", code: "integrity", message: "history returned an invalid page" };
        this.recordRequest(request, "error", this.now());
        return failure;
      }
      const flagOnFailure = this.flagOnFailure(read.value, view);
      if (flagOnFailure) {
        releaseReason = flagOnFailure.code === "unsupported" ? "flag-on-unsupported" : "invalid-flag-on";
        this.recordRequest(request, "error", this.now());
        return flagOnFailure;
      }
      const frozen = immutablePage(read.value);
      const charge = Math.max(
        frozen.payloadBytes,
        encodedBytes(frozen.flagOn ? [frozen.fragments, frozen.flagOn] : frozen.fragments),
      );
      if (charge > STREAM_BUDGET.pageBytesPerViewer) {
        releaseReason = "page-byte-cap";
        const failure: StreamFailure = { status: "error", code: "unsupported", message: "history page exceeds the display byte cap" };
        this.recordRequest(request, "error", this.now());
        return failure;
      }
      this.rememberPage(route.viewerId, this.pageKey(opened.value, cursor, limit), frozen, charge);
      this.recordRequest(request, "ok", this.now());
      return ok(frozen);
    } catch {
      releaseReason = "history-exception";
      this.recordRequest(request, "error", this.now());
      return { status: "error", code: "io", message: "display history read failed" };
    } finally {
      if (view) await this.history.releaseReadView(view, releaseReason);
    }
  }

  async detach(route: ViewerRoute, reason: string): Promise<void> {
    const attachment = this.attachments.get(route.viewerId);
    if (!attachment || !sameRoute(attachment.route, route)) return;
    this.removeAttachment(attachment, { status: "cancelled", reason });
    this.clearViewerPages(route.viewerId);
    this.clearViewerWs(route.viewerId);
  }

  /** Reserve actual encoded bytes for the legacy WebSocket queue. */
  reserveEncodedBytes(viewerId: string, bytes: number): Release | null {
    if (!viewerId || !validCounter(bytes) || bytes > STREAM_BUDGET.wsPendingBytes
      || this.wsPendingBytes + bytes > STREAM_BUDGET.wsPendingBytes) return null;
    if (bytes === 0) return () => {};
    this.wsPendingBytes += bytes;
    this.wsBytes.set(viewerId, (this.wsBytes.get(viewerId) ?? 0) + bytes);
    const epoch = this.wsEpoch.get(viewerId) ?? {};
    this.wsEpoch.set(viewerId, epoch);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.wsEpoch.get(viewerId) !== epoch) return;
      this.wsPendingBytes -= bytes;
      const remaining = (this.wsBytes.get(viewerId) ?? 0) - bytes;
      if (remaining > 0) this.wsBytes.set(viewerId, remaining);
      else { this.wsBytes.delete(viewerId); this.wsEpoch.delete(viewerId); }
    };
  }

  stats(): DisplayEngineStats {
    return deepFreeze({
      attachedViewers: this.attachments.size,
      pagePoolBytes: this.pagePoolBytes,
      pageBytesByViewer: Object.fromEntries(this.pageBytes),
      wsPendingBytes: this.wsPendingBytes,
      wsPendingBytesByViewer: Object.fromEntries(this.wsBytes),
    });
  }

  private routeIsCurrent(route: ViewerRoute): boolean {
    const current = this.attachments.get(route.viewerId);
    return current !== undefined && sameRoute(current.route, route);
  }

  private removeAttachment(attachment: Attachment, unsettled: StreamFailure): void {
    if (this.attachments.get(attachment.route.viewerId) === attachment) this.attachments.delete(attachment.route.viewerId);
    attachment.unsubscribe();
    const settle = attachment.settleInitial;
    attachment.settleInitial = null;
    if (settle) settle(unsettled);
  }

  private validRequest(request: ReadRequest, cursor: PageCursor | null, limit: number): boolean {
    const numbers = [request.routeGeneration, request.range.start, request.range.end, limit];
    if (!Number.isFinite(request.deadlineMonoMs) || request.deadlineMonoMs < 0
      || !numbers.every(validCounter) || request.range.start > request.range.end
      || limit < 1 || limit > STREAM_BUDGET.maxPageRows) return false;
    return cursor === null || (cursor.requestId === request.requestId && validCounter(cursor.lineId)
      && validCounter(cursor.cellOffset) && (cursor.direction === "before" || cursor.direction === "after"));
  }

  private combinedCancel(cancel: CancelToken, route: ViewerRoute, deadlineMonoMs: number): CancelToken {
    return { isCancelled: () => cancel.isCancelled() || !this.routeIsCurrent(route) || this.now() >= deadlineMonoMs };
  }

  private async callWithRetry<T>(
    call: () => Promise<Result<T>>,
    deadlineMonoMs: number,
    cancel: CancelToken,
    route: ViewerRoute,
  ): Promise<Result<T>> {
    for (let attempt = 0; this.retryUntilDeadline || attempt <= STREAM_BUDGET.maxReadRetries; attempt++) {
      if (!this.routeIsCurrent(route)) return staleRoute();
      if (cancel.isCancelled()) return cancelled();
      if (this.now() >= deadlineMonoMs) return deadline();
      const waited = await this.waitFor(call(), deadlineMonoMs, cancel, route);
      if (waited.kind === "failure") return waited.failure;
      if (waited.kind === "throw") return { status: "error", code: "io", message: "display history read failed" };
      const result = waited.value;
      if (result.status !== "busy" || (!this.retryUntilDeadline && attempt === STREAM_BUDGET.maxReadRetries)) return result;
      const pause = Math.min(Math.max(1, result.retryAfterMs), deadlineMonoMs - this.now());
      if (pause > 0) {
        const delayed = await this.waitFor(new Promise<void>(resolve => setTimeout(resolve, pause)), deadlineMonoMs, cancel, route);
        if (delayed.kind === "failure") return delayed.failure;
        if (delayed.kind === "throw") return { status: "error", code: "io", message: "display retry wait failed" };
      }
    }
    return { status: "busy", retryAfterMs: 0, reason: "queue" };
  }

  private async waitFor<T>(promise: Promise<T>, deadlineMonoMs: number, cancel: CancelToken, route: ViewerRoute): Promise<WaitResult<T>> {
    return await new Promise(resolve => {
      let finished = false;
      const finish = (result: WaitResult<T>) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadlineTimer);
        clearInterval(cancelTimer);
        resolve(result);
      };
      const remaining = Math.max(0, deadlineMonoMs - this.now());
      const deadlineTimer = setTimeout(() => finish({ kind: "failure", failure: deadline() }), remaining);
      const cancelTimer = setInterval(() => {
        if (!this.routeIsCurrent(route)) finish({ kind: "failure", failure: staleRoute() });
        else if (cancel.isCancelled()) finish({ kind: "failure", failure: cancelled() });
      }, Math.min(10, Math.max(1, remaining)));
      promise.then(value => finish({ kind: "value", value }), () => finish({ kind: "throw" }));
    });
  }

  private sameView(a: ReadView, b: ReadView): boolean {
    return a.requestId === b.requestId && a.routeGeneration === b.routeGeneration
      && sameIdentity(a.identity, b.identity) && a.grantRevision === b.grantRevision
      && a.durableAtGrant === b.durableAtGrant && a.headAtGrant === b.headAtGrant
      && a.range.start === b.range.start && a.range.end === b.range.end
      && a.overlayHandle === b.overlayHandle;
  }

  private validPage(page: HistoryPage, view: ReadView): boolean {
    if (!validCounter(page.payloadBytes) || page.fragments.length > STREAM_BUDGET.decodeRows) return false;
    for (const fragment of page.fragments) {
      const row = fragment.row;
      if (!samePane(row.id.pane, view.identity.pane) || !samePane(row.source.pane, view.identity.pane)
        || !validCounter(row.id.lineId) || row.id.lineId < view.range.start || row.id.lineId >= view.range.end
        || !validCounter(row.revision) || row.revision > view.grantRevision
        || !validCounter(fragment.startCell) || !validCounter(fragment.endCell)
        || fragment.startCell > fragment.endCell || fragment.endCell - fragment.startCell !== row.cells.length) return false;
    }
    for (const cursor of [page.nextBefore, page.nextAfter]) {
      if (cursor && (cursor.requestId !== view.requestId || !validCounter(cursor.lineId) || !validCounter(cursor.cellOffset))) return false;
    }
    return true;
  }

  /**
   * A flag-on page is shown only with its states intact. Blocked/more must
   * stay pageable on the legacy flags too, so no consumer that reads only
   * hasMore* can mistake pending/gap/remote for the end of history.
   */
  private flagOnFailure(page: HistoryPage, view: ReadView): (StreamFailure & { readonly code: "integrity" | "unsupported" }) | null {
    const extension = page.flagOn;
    const integrity = (message: string) => ({ status: "error", code: "integrity", message } as const);
    if (!extension) {
      return this.flagOn?.required ? integrity("flag-on page arrived without history states") : null;
    }
    if (!this.flagOn) return { status: "error", code: "unsupported", message: "display was not negotiated for flag-on history states" };
    const capabilities = validCapabilities(extension.capabilities);
    if (capabilities === null) return integrity("flag-on page has invalid capabilities");
    if (!capabilities.required.every(cap => this.flagOn!.supported.includes(cap))) {
      return { status: "error", code: "unsupported", message: "flag-on page requires an unsupported capability" };
    }
    const repair = (extension as NewarchHistoryExtension & { repair?: unknown }).repair;
    if (repair !== undefined && !validRepairCapabilities(repair)) return integrity("flag-on repair envelope is unreadable");
    const repairClaimed = repair !== undefined;
    const pane = view.identity.pane;
    const pressureOk = (state: NewarchHistoryState) => validPressureStop(state, pane, repairClaimed);
    if (extension.version !== 1 || !Array.isArray(extension.states)
      || !extension.states.every(state => validHistoryState(state, pane) && pressureOk(state))) {
      return integrity("flag-on page has invalid history states");
    }
    if (!validContinuation(extension.before, pane) || !validContinuation(extension.after, pane)) {
      return integrity("flag-on page has an invalid continuation");
    }
    if (extension.before.kind === "blocked" && !pressureOk(extension.before.state)) {
      return integrity("flag-on page has invalid history states");
    }
    if (extension.after.kind === "blocked" && !pressureOk(extension.after.state)) {
      return integrity("flag-on page has invalid history states");
    }
    if ((extension.before.kind === "end") === page.hasMoreBefore || (extension.after.kind === "end") === page.hasMoreAfter) {
      return integrity("flag-on continuation disagrees with hasMore");
    }
    return null;
  }

  private pageKey(ack: ReadOpenAck, cursor: PageCursor | null, limit: number): string {
    return JSON.stringify([ack.view.requestId, ack.view.grantRevision, ack.diskSnapshotRevision, cursor, limit]);
  }

  private rememberPage(viewerId: string, key: string, page: HistoryPage, bytes: number): void {
    const entries = this.pages.get(viewerId) ?? [];
    const old = entries.find(entry => entry.key === key);
    if (old) {
      old.usedAt = this.now();
      return;
    }
    entries.push({ key, page, bytes, usedAt: this.now() });
    this.pages.set(viewerId, entries);
    this.pageBytes.set(viewerId, (this.pageBytes.get(viewerId) ?? 0) + bytes);
    this.pagePoolBytes += bytes;
    while ((this.pageBytes.get(viewerId) ?? 0) > STREAM_BUDGET.pageBytesPerViewer) this.evictOldest(viewerId);
    while (this.pagePoolBytes > STREAM_BUDGET.pagePoolBytes) {
      let oldestViewer: string | null = null;
      let oldestAt = Infinity;
      for (const [candidate, candidateEntries] of this.pages) {
        const at = candidateEntries[0]?.usedAt ?? Infinity;
        if (at < oldestAt) { oldestAt = at; oldestViewer = candidate; }
      }
      if (oldestViewer === null) break;
      this.evictOldest(oldestViewer);
    }
    this.recordMemory();
  }

  private evictOldest(viewerId: string): void {
    const entries = this.pages.get(viewerId);
    if (!entries?.length) return;
    entries.sort((a, b) => a.usedAt - b.usedAt);
    const entry = entries.shift()!;
    this.pagePoolBytes -= entry.bytes;
    const remaining = (this.pageBytes.get(viewerId) ?? 0) - entry.bytes;
    if (remaining > 0) this.pageBytes.set(viewerId, remaining);
    else {
      this.pageBytes.delete(viewerId);
      this.pages.delete(viewerId);
    }
  }

  private clearViewerPages(viewerId: string): void {
    for (const entry of this.pages.get(viewerId) ?? []) this.pagePoolBytes -= entry.bytes;
    this.pages.delete(viewerId);
    this.pageBytes.delete(viewerId);
    this.recordMemory();
  }

  private clearViewerWs(viewerId: string): void {
    const bytes = this.wsBytes.get(viewerId) ?? 0;
    this.wsPendingBytes -= bytes;
    this.wsBytes.delete(viewerId);
    this.wsEpoch.delete(viewerId);
  }

  private recordMemory(): void {
    this.observer?.record({
      kind: "memory", atMonoMs: this.now(), owner: "display-pages", pane: null,
      heldBytes: this.pagePoolBytes, capacityBytes: STREAM_BUDGET.pagePoolBytes,
    });
  }

  private recordRequest(request: ReadRequest, outcome: "pending" | "ok" | "busy" | "unfenced" | "cancelled" | "error", completedAtMonoMs: number | null): void {
    this.observer?.record({
      kind: "request", requestId: request.requestId, pane: request.identity.pane, operation: "page",
      eligibleAtMonoMs: this.now(), deadlineMonoMs: request.deadlineMonoMs, completedAtMonoMs, outcome,
    });
  }

  private metricOutcome(failure: StreamFailure): "busy" | "cancelled" | "error" {
    if (failure.status === "busy") return "busy";
    if (failure.status === "cancelled") return "cancelled";
    return "error";
  }

  private failureReason(failure: StreamFailure): string {
    if (failure.status === "error" && failure.code === "deadline") return "deadline";
    return failure.status;
  }
}

/** Queued pin/release only. This is not a writer and cannot commit rows. */
export type NewarchV2DisplayPin = Extract<V2WriteCommand, { readonly kind: "pin" | "release-pin" }>;

export interface NewarchV2DisplayPinSink {
  submit(command: NewarchV2DisplayPin): Promise<Result<unknown>>;
}

export interface NewarchV2GeometryIntent {
  readonly source: "viewport" | "font" | "fit-width" | "rotation" | "keyboard-inset" | "apply-geometry";
  readonly columns: number;
  readonly rows: number;
}

export interface NewarchV2Span {
  readonly entries: V2HistoryPage["entries"];
  readonly blocked: NewarchV2ReadState | null;
  readonly ended: boolean;
}

const V2_OWNER_RETRY_MS = 1000;
const V2_SPAN_PAGE_CAP = 64;

function v2PaneEqual(a: NewarchPaneKey, b: NewarchPaneKey): boolean {
  return a.serverIdentity === b.serverIdentity && a.paneId === b.paneId && a.birthGeneration === b.birthGeneration;
}

function v2Integrity(message: string): StreamFailure {
  return { status: "error", code: "integrity", message };
}

/** One pane is a selection. Any longer list stays a list. The last pane is not a tie-break. */
export function selectNewarchV2Panes(
  panes: readonly NewarchV2PaneDescriptor[],
  next: string | null,
): NewarchV2PaneSelection {
  if (panes.length === 0 && next === null) return { kind: "missing" };
  if (panes.length === 1 && next === null) return { kind: "selected", pane: panes[0]! };
  return { kind: "ambiguous", panes: [...panes], next };
}

function v2EntryOrder(entry: V2HistoryPage["entries"][number]): readonly [string, number, number] {
  if (entry.kind === "row") return [entry.row.id.segmentId, entry.row.id.rowOrdinal, 1];
  if (!entry.incident.frontier) return ["", -1, 0];
  return [entry.incident.frontier.segmentId, entry.incident.frontier.rowOrdinal, 0];
}

function v2OrderBefore(left: readonly [string, number, number], right: readonly [string, number, number]): boolean {
  if (left[0] !== right[0]) return left[0] < right[0];
  if (left[1] !== right[1]) return left[1] < right[1];
  return left[2] < right[2];
}

function v2Blocking(state: NewarchV2ReadState): boolean {
  return state.kind === "storage-unavailable" || state.kind === "remote-unavailable";
}

function v2RowKey(row: CommittedStreamRow): string {
  return `${row.id.pane.serverIdentity}\0${row.id.pane.paneId}\0${row.id.pane.birthGeneration}\0${row.id.segmentId}\0${row.id.rowOrdinal}`;
}

/**
 * Read-only NEWARCH display. It never holds a writer capability, never
 * returns a legacy writer, and never turns a blocked remote into end-of-history.
 */
export class NewarchV2Display {
  private pinSerial = 0;

  constructor(
    private readonly reader: V2HistoryReader,
    private readonly pins: NewarchV2DisplayPinSink | null = null,
  ) {}

  select(session: NewarchV2SessionKey): Result<NewarchV2PaneSelection> {
    const owner = this.reader.sessionOwner(session);
    if (owner.status !== "ok") return ok({ kind: "owner-unavailable", retryAfterMs: V2_OWNER_RETRY_MS });
    if (owner.value === null) return ok({ kind: "missing" });
    const listed = this.reader.panes(session, null);
    if (listed.status !== "ok") return ok({ kind: "owner-unavailable", retryAfterMs: V2_OWNER_RETRY_MS });
    return ok(selectNewarchV2Panes(listed.value.panes, listed.value.next));
  }

  /** Viewer size, font, rotation, and applyGeometry never change the birth geometry. */
  geometry(
    pane: NewarchV2PaneDescriptor,
    intent: NewarchV2GeometryIntent,
  ): { readonly reply: NewarchV2GeometryReply; readonly resize: null } {
    const geometry: NewarchV2FixedGeometry = {
      ...pane.geometry,
      columns: intent.columns,
      rows: intent.rows,
    };
    return {
      reply: { schema: NEWARCH_V2_SCHEMA, pane: pane.pane, status: "fixed", geometry },
      resize: null,
    };
  }

  async page(request: NewarchV2HistoryRequest, pinSegmentId: string | null = null): Promise<Result<V2HistoryPage>> {
    try {
      validateV2ReadRequest(request);
    } catch (error) {
      return v2Integrity(error instanceof Error ? error.message : "invalid v2 read");
    }
    const pinId = pinSegmentId && this.pins ? `display-pin-${++this.pinSerial}` : null;
    if (pinId && pinSegmentId && this.pins) {
      const pinned = await this.pins.submit({ kind: "pin", pinId, segmentId: pinSegmentId });
      if (pinned.status !== "ok") return pinned;
    }
    try {
      const read = await this.reader.page(request);
      if (read.status !== "ok") return read;
      const failure = this.pageFailure(request, read.value);
      if (failure) return failure;
      return ok(deepFreeze(structuredClone(read.value)));
    } catch {
      return { status: "error", code: "io", message: "v2 display read failed" };
    } finally {
      if (pinId && this.pins) await this.pins.submit({ kind: "release-pin", pinId });
    }
  }

  /**
   * Follow one cursor across local and remote stores. The same row id is kept
   * once. A blocked continuation stops the walk; it is not an empty end.
   */
  async readSpan(request: NewarchV2HistoryRequest, maxPages: number, pinSegmentId: string | null = null): Promise<Result<NewarchV2Span>> {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) return v2Integrity("v2 span page cap");
    const cap = Math.min(maxPages, V2_SPAN_PAGE_CAP);
    const seen = new Set<string>();
    const entries: V2HistoryPage["entries"][number][] = [];
    let cursor = request.cursor;
    let blocked: NewarchV2ReadState | null = null;
    let ended = false;
    for (let index = 0; index < cap; index++) {
      const read = await this.page({ ...request, cursor }, pinSegmentId);
      if (read.status !== "ok") return read;
      const page = read.value;
      for (const entry of page.entries) {
        if (entry.kind !== "row") {
          entries.push(entry);
          continue;
        }
        const key = v2RowKey(entry.row);
        if (seen.has(key)) return v2Integrity("duplicate v2 row in span");
        seen.add(key);
        entries.push(entry);
      }
      const continuation = request.direction === "before" ? page.before : page.after;
      if (continuation.kind === "blocked") {
        blocked = continuation.state;
        ended = false;
        break;
      }
      if (continuation.kind === "end") {
        ended = blocked === null;
        break;
      }
      cursor = continuation.cursor;
    }
    return ok(deepFreeze({ entries, blocked, ended }));
  }

  private pageFailure(request: NewarchV2HistoryRequest, page: V2HistoryPage): StreamFailure | null {
    if (page.schema !== NEWARCH_V2_VERSION || !v2PaneEqual(page.pane, request.pane)) {
      return v2Integrity("v2 page pane");
    }
    if (!validCounter(page.revision) || !validCounter(page.payloadBytes)
      || page.payloadBytes > request.maxBytes || page.entries.length > request.maxEntries) {
      return v2Integrity("v2 page bound");
    }
    let previous: readonly [string, number, number] | null = null;
    const seen = new Set<string>();
    for (const entry of page.entries) {
      if (entry.kind === "row") {
        if (!entry.row.finalized) return v2Integrity("v2 candidate row is not durable history");
        if (!v2PaneEqual(entry.row.id.pane, request.pane)) return v2Integrity("v2 row pane");
        const key = v2RowKey(entry.row);
        if (seen.has(key)) return v2Integrity("duplicate v2 row");
        seen.add(key);
      } else {
        try {
          validateV2Incident(entry.incident);
        } catch (error) {
          return v2Integrity(error instanceof Error ? error.message : "invalid v2 incident");
        }
        if (!v2PaneEqual(entry.incident.pane, request.pane)) return v2Integrity("v2 incident pane");
      }
      const order = v2EntryOrder(entry);
      if (previous && !v2OrderBefore(previous, order)) return v2Integrity("v2 page order");
      previous = order;
    }
    for (const continuation of [page.before, page.after]) {
      if (continuation.kind === "end") continue;
      if (!v2PaneEqual(continuation.cursor.pane, request.pane) || continuation.cursor.schema !== NEWARCH_V2_SCHEMA) {
        return v2Integrity("v2 continuation cursor");
      }
      if (continuation.kind === "blocked" && !v2Blocking(continuation.state)) return v2Integrity("v2 blocked state");
    }
    const blocking = page.states.some(v2Blocking);
    const blockedContinuation = page.before.kind === "blocked" || page.after.kind === "blocked";
    if (blocking && !blockedContinuation) return v2Integrity("v2 blocking state was reported as the end of history");
    return null;
  }
}
