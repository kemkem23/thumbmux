/** Stream-first I lifecycle. This module never opens tmux or a legacy store. */
import { PipeVtPool, CheckpointCaptureVt, type CaptureVtRpc } from './pipe-vt-worker.js';
import { CaptureAdmission, StreamCaptureEngine, type CapturePorts } from './capture-engine.js';
import { StreamHistoryEngine } from './history-engine.js';
import { StreamDisplayEngine } from './display-engine.js';
import { type StreamIdentity, type Geometry, type LiveFrame, type Result, type VtCheckpoint, type ViewerRoute, type ReadRequest, type PageCursor, type CancelToken, type StreamObserver } from './stream-contract.js';
/** One outstanding J request per channel. Cancellation kills and reaps the
 * shared generation before ACK: destroying a socket alone cannot retire J. */
export declare class StreamVtTransport implements CaptureVtRpc {
    private lease;
    private pending;
    private buffer;
    private closed;
    private retirement;
    private resetting;
    private starting;
    private pool;
    private geometry;
    private epoch;
    private transactionActive;
    get pid(): number | null;
    start(pool: PipeVtPool, geometry: Geometry, epoch: number): Promise<void>;
    private openChannel;
    private fail;
    private call;
    transaction(request: Parameters<CaptureVtRpc['transaction']>[0]): ReturnType<CaptureVtRpc['transaction']>;
    private resetGeneration;
    retire(): Promise<void>;
    close(): Promise<void>;
}
export interface StreamPanePorts extends Pick<CapturePorts, 'visible' | 'repairChunks' | 'syncRepair' | 'verifyRepair' | 'repairedCheckpoint'> {
    /** Resolve after source RPC/readers/commits are retired, not merely aborted. */
    cancelOperation(signal: AbortSignal): Promise<void>;
}
export interface StreamRuntimeOptions {
    path: string;
    pool?: PipeVtPool;
    python?: string;
    observer?: StreamObserver;
}
export declare class StreamRuntime {
    readonly options: StreamRuntimeOptions;
    readonly pool: PipeVtPool;
    readonly admission: CaptureAdmission;
    readonly scratch: CaptureAdmission;
    history: StreamHistoryEngine | null;
    private panes;
    private closing;
    private sharedDisplay;
    private readonly timer;
    private ticks;
    private viewerSlots;
    constructor(options: StreamRuntimeOptions);
    displayEngine(): StreamDisplayEngine;
    reserveViewer(id: string, owner: StreamRuntimePane): boolean;
    releaseViewer(id: string): void;
    /** `adoptRecoveredGeometry`: boot finalization replays a stored tenure and
     * must not append a resize event that the source never produced. */
    add(identity: StreamIdentity, geometry: Geometry, ports: StreamPanePorts, scrollOnClear?: boolean, options?: {
        adoptRecoveredGeometry?: boolean;
    }): Promise<StreamRuntimePane>;
    /** Handoff release: the caller already froze the pane's durable fence (a
     * checkpoint, or rows flushed behind a durable gap episode). No new drain. */
    retire(pane: StreamRuntimePane): Promise<void>;
    remove(pane: StreamRuntimePane): Promise<void>;
    close(): Promise<void>;
}
export declare class StreamRuntimePane {
    readonly runtime: StreamRuntime;
    readonly rpc: StreamVtTransport;
    private readonly vt;
    private readonly ports;
    capture: StreamCaptureEngine;
    display: StreamDisplayEngine;
    frame: LiveFrame;
    identity: StreamIdentity;
    private sequence;
    private accepting;
    private chain;
    private inputBytes;
    private viewers;
    private closed;
    private cadence;
    private cadenceReady;
    private receivedAt;
    private liveViewers;
    setLiveViewers(count: number): void;
    constructor(runtime: StreamRuntime, rpc: StreamVtTransport, vt: CheckpointCaptureVt, identity: StreamIdentity, ports: StreamPanePorts);
    private makeCapture;
    startCadence(): void;
    stopCadence(): void;
    tick(): Promise<void>;
    recover(): Promise<void>;
    /** Whole FIFO slice is owned until the promise resolves; never acknowledge a
     * partial slice as capacity-pressure (which would cause duplicate retry). */
    ingest(bytes: Uint8Array): Promise<void>;
    private event;
    resize(geometry: Geometry): Promise<void>;
    attach(route: ViewerRoute, onFrame: (frame: LiveFrame) => void): Promise<Result<LiveFrame>>;
    page(route: ViewerRoute, request: ReadRequest, cursor: PageCursor | null, limit: number, cancel: CancelToken): Promise<Result<import("./stream-contract.js").HistoryPage>>;
    detach(viewerId: string): Promise<void>;
    drain(): Promise<VtCheckpoint | null>;
    /** Await the input already handed to this pane, without draining it. */
    settle(): Promise<void>;
    retire(): Promise<void>;
    close(): Promise<void>;
    stats(): {
        inputBytes: number;
        packetSeq: number;
        frame: LiveFrame;
        workerPid: number | null;
        display: import("./display-engine.js").DisplayEngineStats;
        history: {
            recoveryTimers: number;
            pendingBytes: number;
            ownedPendingBytes: number;
            overlayBytes: number;
            activeReads: number;
            pins: number;
            diskCacheConfigBytes: number;
        };
    };
}
