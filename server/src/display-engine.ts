import {
  STREAM_BUDGET,
  validReadOpen,
  type CancelToken,
  type CaptureEngine,
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
  type ViewerRoute,
} from "./stream-contract";

type Release = () => void;

export interface DisplayEngineOptions {
  readonly capture: CaptureEngine;
  readonly history: HistoryEngine;
  readonly observer?: StreamObserver;
  readonly now?: () => number;
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

function samePane(a: StreamIdentity["pane"], b: StreamIdentity["pane"]): boolean {
  return a.serverIdentity === b.serverIdentity && a.paneId === b.paneId && a.birthGeneration === b.birthGeneration;
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
  });
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

type WaitResult<T> = { readonly kind: "value"; readonly value: T }
  | { readonly kind: "failure"; readonly failure: StreamFailure }
  | { readonly kind: "throw" };

export class StreamDisplayEngine implements DisplayEngine {
  private readonly capture: CaptureEngine;
  private readonly history: HistoryEngine;
  private readonly observer: StreamObserver | undefined;
  private readonly now: () => number;
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
    this.capture = options.capture;
    this.history = options.history;
    this.observer = options.observer;
    this.now = options.now ?? (() => performance.now());
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
      const frozen = immutablePage(read.value);
      const charge = Math.max(frozen.payloadBytes, encodedBytes(frozen.fragments));
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
    for (let attempt = 0; attempt <= STREAM_BUDGET.maxReadRetries; attempt++) {
      if (!this.routeIsCurrent(route)) return staleRoute();
      if (cancel.isCancelled()) return cancelled();
      if (this.now() >= deadlineMonoMs) return deadline();
      const waited = await this.waitFor(call(), deadlineMonoMs, cancel, route);
      if (waited.kind === "failure") return waited.failure;
      if (waited.kind === "throw") return { status: "error", code: "io", message: "display history read failed" };
      const result = waited.value;
      if (result.status !== "busy" || attempt === STREAM_BUDGET.maxReadRetries) return result;
      const pause = Math.min(result.retryAfterMs, deadlineMonoMs - this.now());
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
