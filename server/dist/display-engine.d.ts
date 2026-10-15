import { type NewarchFlagOnCapability, type NewarchV2GeometryReply, type NewarchV2HistoryRequest, type NewarchV2PaneDescriptor, type NewarchV2PaneSelection, type NewarchV2ReadState, type NewarchV2SessionKey } from "@thumbmux/core";
import { type CancelToken, type CaptureEngine, type DisplayEngine, type HistoryEngine, type HistoryPage, type LiveFrame, type PageCursor, type ReadRequest, type Result, type StreamObserver, type V2HistoryPage, type V2HistoryReader, type V2WriteCommand, type ViewerRoute } from "./stream-contract";
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
export declare class StreamDisplayEngine implements DisplayEngine {
    private readonly capture;
    private readonly retryUntilDeadline;
    private readonly history;
    private readonly observer;
    private readonly now;
    private readonly flagOn;
    private readonly attachments;
    private readonly pages;
    private readonly pageBytes;
    private pagePoolBytes;
    private readonly wsBytes;
    private readonly wsEpoch;
    private wsPendingBytes;
    constructor(options: DisplayEngineOptions);
    attach(route: ViewerRoute, onFrame: (frame: LiveFrame) => void): Promise<Result<LiveFrame>>;
    page(route: ViewerRoute, request: ReadRequest, cursor: PageCursor | null, limit: number, cancel: CancelToken): Promise<Result<HistoryPage>>;
    detach(route: ViewerRoute, reason: string): Promise<void>;
    /** Reserve actual encoded bytes for the legacy WebSocket queue. */
    reserveEncodedBytes(viewerId: string, bytes: number): Release | null;
    stats(): DisplayEngineStats;
    private routeIsCurrent;
    private removeAttachment;
    private validRequest;
    private combinedCancel;
    private callWithRetry;
    private waitFor;
    private sameView;
    private validPage;
    /**
     * A flag-on page is shown only with its states intact. Blocked/more must
     * stay pageable on the legacy flags too, so no consumer that reads only
     * hasMore* can mistake pending/gap/remote for the end of history.
     */
    private flagOnFailure;
    private pageKey;
    private rememberPage;
    private evictOldest;
    private clearViewerPages;
    private clearViewerWs;
    private recordMemory;
    private recordRequest;
    private metricOutcome;
    private failureReason;
}
/** Queued pin/release only. This is not a writer and cannot commit rows. */
export type NewarchV2DisplayPin = Extract<V2WriteCommand, {
    readonly kind: "pin" | "release-pin";
}>;
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
/** One pane is a selection. Any longer list stays a list. The last pane is not a tie-break. */
export declare function selectNewarchV2Panes(panes: readonly NewarchV2PaneDescriptor[], next: string | null): NewarchV2PaneSelection;
/**
 * Read-only NEWARCH display. It never holds a writer capability, never
 * returns a legacy writer, and never turns a blocked remote into end-of-history.
 */
export declare class NewarchV2Display {
    private readonly reader;
    private readonly pins;
    private pinSerial;
    constructor(reader: V2HistoryReader, pins?: NewarchV2DisplayPinSink | null);
    select(session: NewarchV2SessionKey): Result<NewarchV2PaneSelection>;
    /** Viewer size, font, rotation, and applyGeometry never change the birth geometry. */
    geometry(pane: NewarchV2PaneDescriptor, _intent: NewarchV2GeometryIntent): {
        readonly reply: NewarchV2GeometryReply;
        readonly resize: null;
    };
    page(request: NewarchV2HistoryRequest, pinSegmentId?: string | null): Promise<Result<V2HistoryPage>>;
    /**
     * Follow one cursor across local and remote stores. The same row id is kept
     * once. A blocked continuation stops the walk; it is not an empty end.
     */
    readSpan(request: NewarchV2HistoryRequest, maxPages: number, pinSegmentId?: string | null): Promise<Result<NewarchV2Span>>;
    private pageFailure;
}
export {};
