import { type CancelToken, type CaptureEngine, type DisplayEngine, type HistoryEngine, type HistoryPage, type LiveFrame, type PageCursor, type ReadRequest, type Result, type StreamObserver, type ViewerRoute } from "./stream-contract";
type Release = () => void;
export interface DisplayEngineOptions {
    /** Stream runtime opt-in: contention may use the full request deadline. */
    readonly retryUntilDeadline?: boolean;
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
export declare class StreamDisplayEngine implements DisplayEngine {
    private readonly capture;
    private readonly retryUntilDeadline;
    private readonly history;
    private readonly observer;
    private readonly now;
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
export {};
