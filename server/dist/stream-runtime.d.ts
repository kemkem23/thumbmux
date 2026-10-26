/** Stream-first I lifecycle. This module never opens tmux or a legacy store. */
import { PipeVtPool, CheckpointCaptureVt, type CaptureVtRpc } from './pipe-vt-worker';
import { CaptureAdmission, StreamCaptureEngine, type CapturePorts } from './capture-engine';
import { StreamHistoryEngine } from './history-engine';
import { StreamDisplayEngine } from './display-engine';
import { type StreamIdentity, type Geometry, type LiveFrame, type Result, type VtCheckpoint, type ViewerRoute, type ReadRequest, type PageCursor, type CancelToken, type StreamObserver } from './stream-contract';
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
    page(route: ViewerRoute, request: ReadRequest, cursor: PageCursor | null, limit: number, cancel: CancelToken): Promise<Result<import("./stream-contract").HistoryPage>>;
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
        display: import("./display-engine").DisplayEngineStats;
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
import type { Cell as FlagOnCell, PipeEpoch as FlagOnEpoch, StitchRow as FlagOnStitchRow, Cursor as FlagOnCursor } from './stream-contract';
export declare const FLAGON_DECODER_CODEC = "flagon-decoder-v1";
/** Same field names as C's KnownStateTracker so withheld reasons line up. */
export declare const FLAGON_STATE_FIELDS: readonly ["sgr", "cursor", "savedCursor", "margins", "charset", "pendingUtf8", "pendingEscape", "wrap"];
export type FlagOnStateField = typeof FLAGON_STATE_FIELDS[number] | 'unsupported-sequence' | 'geometry';
export interface FlagOnDecoderSeed {
    /** Capture rows of the live screen (packet rows at index ≥ historySize), top first. */
    readonly screen: readonly FlagOnStitchRow[];
    readonly cursor: FlagOnCursor;
    readonly alternate: boolean;
    readonly stateKnown: Readonly<Record<string, boolean>>;
}
export interface FlagOnDecoderOptions {
    readonly epoch: FlagOnEpoch;
    readonly geometry: Geometry;
    /** tmux `scroll-on-clear` (default on in 3.4): ED 2 pushes the screen into history. */
    readonly scrollOnClear: boolean;
    readonly seed?: FlagOnDecoderSeed;
}
export declare class FlagOnVtDecoder {
    readonly epoch: FlagOnEpoch;
    geometry: Geometry;
    private normal;
    private alt;
    private pen;
    private unknown;
    private top;
    private bottom;
    private autowrap;
    private pendingWrap;
    private utf8;
    private utf8Need;
    private utf8Start;
    private esc;
    private ordinal;
    private offset;
    /** A geometry break has no exact mapping. Further bytes advance the offset
     * so the next pull does not throw, and they never become rows. */
    private halted;
    private readonly scrollOnClear;
    /** Finalized rows waiting for `take()`. */
    private out;
    /** tmux's visible screen read while bytes were still in flight: compared at
     * every line feed and feed end until it matches or expires (see verifyVisible). */
    private target;
    /** Byte offsets where an earlier run proved this exact state (replay after a
     * host restart re-applies them; the parser is deterministic). */
    private proven;
    replayProven(offsets: readonly number[]): void;
    constructor(options: FlagOnDecoderOptions);
    private known;
    private blankLine;
    private blankScreen;
    private get screen();
    unknownFields(): FlagOnStateField[];
    get position(): number;
    get alternateActive(): boolean;
    cursor(): {
        x: number;
        y: number;
    };
    /** Feed acknowledged raw bytes starting at collector offset `start`. */
    feed(bytes: ArrayLike<number>, start: number): void;
    /** Verify against a visible read taken at an unknown byte position at or
     * after the current one (output kept flowing). The first parser state that
     * reproduces it exactly — checked at line feeds and feed ends, up to
     * `withinBytes` further bytes — proves the state; none expires unverified. */
    verifyLater(visible: Parameters<FlagOnVtDecoder['verifyVisible']>[0], withinBytes: number): Promise<{
        verified: boolean;
        reason: string | null;
        at: number;
    }>;
    private tryTarget;
    /** Rows that scrolled into history since the last call, oldest first. */
    take(): FlagOnStitchRow[];
    private pipeOrigin;
    private cellAt;
    private markLine;
    private markAll;
    private blank;
    private padTo;
    private byte;
    private flushUtf8;
    private print;
    private lineFeed;
    /** Region scroll; in the normal buffer tmux moves the region's top line into history. */
    private scrollUp;
    private scrollDown;
    private emit;
    private eraseInLine;
    private escByte;
    private csi;
    private sgr;
    private eraseDisplay;
    private save;
    private restore;
    private switchBuffer;
    private reset;
    /** The live screen as non-finalized rows (display only, never committed). */
    screenRows(): FlagOnStitchRow[];
    /** Visible verification (DESIGN §3.3): `visible` is tmux's own screen read
     * (`capture-pane -p -e -N` of the visible rows) with its cursor and scroll
     * region. When every cell, the cursor, the buffer and the region agree, the
     * parser provably reproduces the terminal: unknown fields are cleared and
     * every live row is proven. Any difference leaves the state unknown and is
     * reported, so the caller can keep withholding. */
    verifyVisible(visible: {
        rows: readonly (readonly FlagOnCell[])[];
        cursor: {
            x: number;
            y: number;
        };
        alternate: boolean;
        regionTop: number;
        regionBottom: number;
        geometry: Geometry;
    }): {
        verified: boolean;
        reason: string | null;
    };
    /** The pen itself is not visible; a verified screen still leaves it as the
     * style the parser holds, which tmux just rendered identically. */
    private clearProven;
    /** Geometry changed without a mapping. Do not shift or truncate: a shortened
     * row must not be committed as exact. The caller falls back to legacy. */
    resize(geometry: Geometry): void;
}
import { type V2DecisionContext } from './capture-engine';
import { type V2Config, type V2RuleResult, type V2LiveCheckpoint, type NewarchV2PaneDescriptor, type RawRange } from './stream-contract';
export declare class V2Jigsaw {
    private checkpoint;
    private readonly pane;
    private config;
    private pending;
    private since;
    private end;
    private stopped;
    private proposed;
    constructor(checkpoint: V2LiveCheckpoint, pane: NewarchV2PaneDescriptor, config?: V2Config);
    get pendingBytes(): number;
    get deadlineMonoMs(): number | null;
    get liveCheckpoint(): V2LiveCheckpoint;
    evaluate(raw: RawRange, bytes: readonly number[], now: number, context: V2DecisionContext): V2RuleResult;
    expire(now: number, context: V2DecisionContext): V2RuleResult | null;
    /** Receipt verification belongs to the engine/H boundary; this requires the
     * exact proposed checkpoint, never a caller-created screen snapshot. */
    committed(checkpointId: string): void;
    /** Only after H has definitively rejected/rolled back the transaction.
     * A timeout or lost ACK is NOT rejection: reconcile/retry the same decision.
     * S still owns the unACKed bytes; reread from the returned durable frontier. */
    rejected(checkpointId: string): import('./stream-contract').RawPosition;
    configure(config: V2Config): void;
}
