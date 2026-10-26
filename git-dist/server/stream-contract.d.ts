/** Stream-first v1. Normative semantics: docs/tasks/newarch-stream/DESIGN.md.
 * No I/O here. Implementations must validate untrusted input at their boundary.
 * All counters are nonnegative safe integers; line ranges are [start, end).
 * Readonly is an ownership contract: implementations must copy/freeze buffers.
 */
export declare const STREAM_CONTRACT_VERSION: 1;
export declare const STREAM_BUDGET: Readonly<{
    readonly processTreePssHardBytes: number;
    readonly memoryDebtTargetBytes: number;
    readonly plateauMinMs: number;
    readonly plateauMaxDeltaBytes: number;
    readonly panes: 21;
    readonly maxColumns: 240;
    readonly maxRows: 80;
    readonly vtBytesPerPane: number;
    readonly tailRowsPerPane: 256;
    readonly tailBytesPerPane: number;
    readonly rawBytesPerPane: number;
    readonly metadataBytesPerPane: number;
    readonly pendingBytes: number;
    readonly scratchBytes: number;
    readonly diskCacheBytes: number;
    readonly pagePoolBytes: number;
    readonly pageBytesPerViewer: number;
    readonly wsPendingBytes: number;
    readonly unattributedReserveBytes: number;
    readonly blockRows: 256;
    readonly blockPayloadBytes: number;
    readonly decodeRows: 256;
    readonly decodeBytes: number;
    readonly pageBytes: number;
    readonly defaultPageRows: 500;
    readonly maxPageRows: 2000;
    readonly repairHorizonRows: 5012;
    readonly activeReadsGlobal: 2;
    readonly activeReadsPerPane: 1;
    readonly queuedReads: 21;
    readonly readDeadlineMs: 1000;
    readonly releasePinMs: 1000;
    readonly maxReadRetries: 2;
    readonly checkpointMs: 1000;
    readonly checkpointRows: 256;
    readonly fsyncBatchTargetMs: 20;
    readonly watchdogMs: 250;
    readonly stalledInputMs: 500;
    readonly recoveryMs: 10000;
    readonly visibleActiveMs: 200;
    readonly visibleIdleMs: 1000;
    readonly visibleNoViewerMs: 5000;
    readonly visibleEventMs: 50;
    readonly visibleDeadlineMs: 1000;
    readonly latencyP95Ms: 45;
    readonly latencyP99Ms: 80;
    readonly pairedUpperCi95Ms: 3;
    readonly quietP95Ms: 50;
    readonly stressLatencyRatio: 1.25;
    readonly stressDrainMs: 25000;
    readonly normalMissingRows: 0;
    readonly plannedMissingRows: 0;
    readonly spikeFaultMissingRows: 0;
    readonly unexpectedMarkedRowsPerPane: 5;
    readonly unexpectedFaultRowsPerSecond: 2;
}>;
/** A fresh encoder. Share it only inside one synchronous call: the next call
 * must see mutations of objects the previous call already encoded. */
export declare function streamCanonicalEncoder(): (value: unknown) => string;
export declare function streamCanonical(value: unknown, encode?: (value: unknown) => string): string;
export declare function streamDigest(kind: string, payload: unknown): string;
export interface PaneKey {
    readonly serverIdentity: string;
    readonly paneId: string;
    readonly birthGeneration: number;
}
export interface StreamIdentity {
    readonly pane: PaneKey;
    readonly sourceEpoch: number;
    readonly geometryGeneration: number;
}
/** packetSeq orders bytes AND resize/control events within an epoch.
 * It is host receive order, never proof of tmux source byte continuity.
 */
export interface InputPosition {
    readonly sourceEpoch: number;
    readonly packetSeq: number;
}
export interface EventId extends InputPosition {
    readonly pane: PaneKey;
    readonly scrollOrdinal: number;
}
export interface RowId {
    readonly pane: PaneKey;
    readonly lineId: number;
}
export interface RowRange {
    readonly start: number;
    readonly end: number;
}
export type Digest = string;
export interface Geometry {
    readonly columns: number;
    readonly rows: number;
}
export interface StyleRun {
    readonly startCell: number;
    readonly endCell: number;
    readonly sgr: readonly number[];
}
/** Durable/legacy style is canonical full-state SGR parameters, with implicit
 * reset before each cell. Never [attrs, fg, bg]. Text retains combining codepoints;
 * width 0 is a continuation slot, not permission to drop text during conversion. */
export interface Cell {
    readonly text: string;
    readonly width: 0 | 1 | 2;
    readonly style: readonly number[];
}
export interface RowContent {
    readonly cells: readonly Cell[];
    readonly softWrap: boolean;
    readonly wrapPad: number;
    readonly uncertainFields: readonly string[];
}
export interface FinalizedRow extends RowContent {
    readonly id: RowId;
    readonly revision: number;
    readonly source: EventId;
    readonly geometryGeneration: number;
    readonly geometry: Geometry;
}
/** Receive timestamp is host monotonic milliseconds, not wall time. */
export interface InputEvent {
    readonly identity: StreamIdentity;
    readonly position: InputPosition;
    readonly receivedAtMonoMs: number;
    readonly digest: Digest;
    readonly payload: {
        readonly kind: 'bytes';
        readonly bytes: readonly number[];
    } | {
        readonly kind: 'resize';
        readonly geometry: Geometry;
    } | {
        readonly kind: 'control';
        readonly name: string;
        readonly data: string;
    };
}
export interface FrameDelta {
    readonly identity: StreamIdentity;
    readonly screenRevision: number;
    readonly buffer: 'normal' | 'alternate';
    readonly geometry: Geometry;
    readonly changedRows: readonly {
        readonly y: number;
        readonly content: RowContent;
    }[];
    readonly cursor: Cursor;
    readonly overlap: RowRange | null;
}
export interface LiveFrame extends FrameDelta {
    readonly revision: number;
    readonly durableRevision: number;
    readonly head: number;
}
export interface RamReceipt {
    readonly kind: 'ram';
    readonly eventId: EventId;
    readonly digest: Digest;
    readonly revision: number;
    readonly head: number;
}
export interface DurableReceipt {
    readonly kind: 'durable';
    readonly pane: PaneKey;
    readonly commitId: string;
    readonly digest: Digest;
    readonly durableRevision: number;
    readonly checkpointId: string;
}
export interface DurableInputReceipt {
    readonly kind: 'durable-input';
    readonly pane: PaneKey;
    readonly through: InputPosition;
    readonly digest: Digest;
    readonly segmentId: string;
}
export type StreamFailure = {
    readonly status: 'busy';
    readonly retryAfterMs: number;
    readonly reason: 'pressure' | 'queue' | 'snapshot-gate';
} | {
    readonly status: 'stale';
    readonly reason: 'identity' | 'route' | 'geometry' | 'epoch' | 'late-gap';
} | {
    readonly status: 'cancelled';
    readonly reason: string;
} | {
    readonly status: 'error';
    readonly code: 'integrity' | 'io' | 'unsupported' | 'unresolved-gap' | 'deadline';
    readonly message: string;
};
export type Result<T> = {
    readonly status: 'ok';
    readonly value: T;
} | StreamFailure;
/** eventId.scrollOrdinal is the first row ordinal of this bounded packet prefix.
 * Row j has ordinal start+j; each prefix advances revision once. */
export interface AppendFinalized {
    readonly identity: StreamIdentity;
    readonly eventId: EventId;
    readonly digest: Digest;
    readonly expectedRevision: number;
    readonly rows: readonly FinalizedRow[];
    readonly frameDelta: FrameDelta;
    readonly receivedAtMonoMs: number;
}
export interface Cursor {
    readonly x: number;
    readonly y: number;
    readonly visible: boolean;
}
export interface VtBuffer {
    readonly rows: readonly RowContent[];
    readonly cursor: Cursor;
    readonly savedCursor: Cursor;
    readonly savedAttributes: readonly number[];
    readonly savedModes: Readonly<Record<string, boolean | number>>;
    readonly wrapPending: boolean;
}
/** Full parser state, not capture-pane text. codecVersion is checked before restore.
 * extensionState encodes parser-specific charset/decoder state not listed here;
 * unsupported versions must fail closed, never silently reseed a screen.
 */
export interface VtState {
    /** extension means rows live in the admitted codec, never interpreted as blank.
     * C2 uses bounded zlib/base64 z1; decoded scratch <=8 MiB, VT charge unchanged. */
    readonly bufferEncoding?: 'extension';
    readonly codecVersion: string;
    readonly geometry: Geometry;
    readonly normal: VtBuffer;
    readonly alternate: VtBuffer;
    readonly active: 'normal' | 'alternate';
    readonly modes: Readonly<Record<string, boolean | number>>;
    readonly margins: {
        readonly top: number;
        readonly bottom: number;
        readonly left: number;
        readonly right: number;
    };
    readonly tabStops: readonly number[];
    readonly pendingUtf8: readonly number[];
    readonly pendingEscape: readonly number[];
    readonly attributes: readonly number[];
    readonly wrapPending: boolean;
    readonly extensionState: string;
}
export interface VtCheckpoint {
    readonly kind: 'vt-recovery';
    readonly checkpointId: string;
    readonly previousCheckpointId: string | null;
    readonly identity: StreamIdentity;
    readonly inputFence: DurableInputReceipt;
    readonly revision: number;
    readonly head: number;
    readonly state: VtState;
    readonly stateDigest: Digest;
}
export interface RowCursor {
    readonly lineId: number;
    readonly cellOffset: number;
}
export interface HistoryPageCheckpoint {
    readonly kind: 'history-page';
    readonly blockId: string;
    readonly pane: PaneKey;
    readonly previousBlockId: string | null;
    readonly first: RowCursor;
    readonly end: RowCursor;
    readonly minRevision: number;
    readonly maxRevision: number;
    readonly checksum: Digest;
    readonly rowCount: number;
    readonly payloadBytes: number;
    readonly geometryAndWrap: readonly {
        readonly lineId: number;
        readonly geometryGeneration: number;
        readonly geometry: Geometry;
        readonly softWrap: boolean;
        readonly wrapPad: number;
    }[];
}
export interface WalCheckpoint {
    readonly kind: 'sqlite-wal';
    readonly busyReaders: number;
    readonly remainingFrames: number;
}
export interface CheckpointCommit {
    readonly checkpoint: VtCheckpoint;
    readonly expectedRevision: number;
    readonly commitId: string;
    readonly digest: Digest;
    /** Close only this fenced episode, after its final rows and verified VT restore. */
    readonly closeGap?: string;
}
export interface GapEpisode {
    readonly episodeId: string;
    readonly pane: PaneKey;
    readonly epochBefore: number;
    readonly epochAfter: number | null;
    readonly lastDurableInput: InputPosition | null;
    readonly lastAdmittedRow: number | null;
    readonly firstObservedAtMonoMs: number;
    readonly reason: 'eof' | 'reader-error' | 'worker-exit' | 'sequence' | 'ack-timeout' | 'checksum' | 'pressure' | 'identity' | 'geometry' | 'visible-divergence' | 'stalled-input' | 'late-gap';
    readonly status: 'suspected' | 'repairing' | 'unresolved' | 'repaired';
    readonly missingCount: number | null;
}
export interface RepairChunk {
    readonly episode: GapEpisode;
    readonly chunkId: string;
    readonly digest: Digest;
    readonly expectedRevision: number;
    readonly rows: readonly FinalizedRow[];
    readonly final: boolean;
}
export interface RepairReceipt {
    readonly committedIds: readonly RowId[];
    readonly committedRevision: number;
    readonly durable: DurableReceipt;
    readonly complete: boolean;
    readonly finalChunk?: boolean;
}
/** Yield each committed chunk immediately. Later failure cannot erase that prefix. */
export type RecoveryChunk = {
    readonly kind: 'checkpoint';
    readonly checkpoint: VtCheckpoint;
} | {
    readonly kind: 'input';
    readonly event: InputEvent;
} | {
    readonly kind: 'rows';
    readonly rows: readonly FinalizedRow[];
    readonly receipt: DurableReceipt;
};
export interface ReadRequest {
    readonly requestId: string;
    readonly identity: StreamIdentity;
    readonly routeGeneration: number;
    readonly range: RowRange;
    readonly deadlineMonoMs: number;
}
export interface ReadView extends ReadRequest {
    readonly grantRevision: number;
    readonly durableAtGrant: number;
    readonly headAtGrant: number;
    readonly overlayHandle: string;
}
export interface ReadOpenAck {
    readonly view: ReadView;
    readonly diskSnapshotRevision: number;
    readonly snapshotHandle: string;
}
export interface PageCursor extends RowCursor {
    readonly requestId: string;
    readonly direction: 'before' | 'after';
}
/** Large rows/logical lines continue at cellOffset; byte truncation is never EOF. */
export interface RowFragment {
    readonly row: FinalizedRow;
    readonly startCell: number;
    readonly endCell: number;
    readonly complete: boolean;
}
export interface HistoryPage {
    readonly view: ReadView;
    readonly fragments: readonly RowFragment[];
    readonly payloadBytes: number;
    readonly nextBefore: PageCursor | null;
    readonly nextAfter: PageCursor | null;
    readonly hasMoreBefore: boolean;
    readonly hasMoreAfter: boolean;
}
export interface CancelToken {
    readonly isCancelled: () => boolean;
}
export interface CaptureEngine {
    /** Reserve before mutation; busy retries exact same event/digest. */
    acceptInput(event: InputEvent): Promise<Result<DurableInputReceipt>>;
    checkpoint(pane: PaneKey, reason: 'periodic' | 'row-limit' | 'handoff'): Promise<Result<VtCheckpoint>>;
    restore(checkpoint: VtCheckpoint, input: AsyncIterable<InputEvent>): Promise<Result<LiveFrame>>;
    checkVisible(identity: StreamIdentity): Promise<Result<{
        readonly verdict: 'equal' | 'different' | 'unfenced';
    }>>;
    repair(episode: GapEpisode, cancel: CancelToken): AsyncIterable<Result<RepairReceipt>>;
    subscribe(pane: PaneKey, listener: (frame: LiveFrame) => void): () => void;
    drain(pane: PaneKey, deadlineMonoMs: number): Promise<Result<DurableReceipt>>;
}
export interface HistoryEngine {
    /** Synchronous durable fence; callers must observe ACK before recovery/suffix. */
    beginGap(episode: GapEpisode): Result<null>;
    journalInput(event: InputEvent): Promise<Result<DurableInputReceipt>>;
    /** Retry identity+digest returns original receipt; different digest is integrity error.
     * Gap fence blocks assigning IDs to suffix. Alt scroll never appends normal history.
     */
    appendFinalized(request: AppendFinalized): Promise<Result<RamReceipt>>;
    commitCheckpoint(request: CheckpointCommit): Promise<Result<DurableReceipt>>;
    recover(pane: PaneKey, checkpointId: string | null, cancel: CancelToken): AsyncIterable<Result<RecoveryChunk>>;
    commitRepair(chunk: RepairChunk): Promise<Result<RepairReceipt>>;
    grantReadView(request: ReadRequest): Promise<Result<ReadView>>;
    /** BEGIN + actual read establishes s; enforce d <= s <= g before releasing gate. */
    openReadView(view: ReadView): Promise<Result<ReadOpenAck>>;
    readPage(ack: ReadOpenAck, cursor: PageCursor | null, limit: number, cancel: CancelToken): Promise<Result<HistoryPage>>;
    /** Idempotent; finally on error, timeout, cancel, disconnect or route change. */
    releaseReadView(view: ReadView, reason: string): Promise<void>;
}
export interface ViewerRoute {
    readonly viewerId: string;
    readonly identity: StreamIdentity;
    readonly routeGeneration: number;
}
export interface DisplayEngine {
    attach(route: ViewerRoute, onFrame: (frame: LiveFrame) => void): Promise<Result<LiveFrame>>;
    page(route: ViewerRoute, request: ReadRequest, cursor: PageCursor | null, limit: number, cancel: CancelToken): Promise<Result<HistoryPage>>;
    detach(route: ViewerRoute, reason: string): Promise<void>;
}
export type MemoryOwner = 'vt' | 'tail' | 'raw' | 'metadata' | 'pending' | 'scratch' | 'disk-cache' | 'display-pages' | 'ws' | 'unattributed';
export type StreamMetric = {
    readonly kind: 'memory';
    readonly atMonoMs: number;
    readonly owner: MemoryOwner;
    readonly pane: PaneKey | null;
    readonly heldBytes: number;
    readonly capacityBytes: number;
} | {
    readonly kind: 'publish';
    readonly eventId: EventId;
    readonly receivedAtMonoMs: number;
    readonly ramPublishedAtMonoMs: number;
    readonly durableAtMonoMs: number | null;
} | {
    readonly kind: 'request';
    readonly requestId: string;
    readonly pane: PaneKey;
    readonly operation: 'visible' | 'page' | 'repair';
    readonly eligibleAtMonoMs: number;
    readonly deadlineMonoMs: number;
    readonly completedAtMonoMs: number | null;
    readonly outcome: 'pending' | 'ok' | 'busy' | 'unfenced' | 'cancelled' | 'error';
} | {
    readonly kind: 'gap';
    readonly episode: GapEpisode;
} | {
    readonly kind: 'lifecycle';
    readonly identity: StreamIdentity;
    readonly atMonoMs: number;
    readonly reason: string;
    readonly errorStack: string | null;
} | {
    readonly kind: 'pss';
    readonly atMonoMs: number;
    readonly processes: readonly {
        readonly pid: number;
        readonly startTime: string;
        readonly role: string;
        readonly pssBytes: number | null;
    }[];
    readonly valid: boolean;
};
export interface StreamObserver {
    record(metric: StreamMetric): void;
}
/** Unambiguous keys, unlike delimiter concatenation; validate counters at ingress. */
export declare function eventKey(id: EventId): string;
export declare function rowKey(id: RowId): string;
export declare function validReadOpen(ack: ReadOpenAck): boolean;
import type { NewarchCapabilities, NewarchGap, NewarchHistoryCursor, NewarchHistoryExtension, NewarchHistoryState, NewarchRowId, NewarchRowRange } from '../core/index.js';
export type { NewarchCapabilities, NewarchHistoryCursor, NewarchHistoryState } from '../core/index.js';
export declare const FLAGON_VERSIONS: Readonly<{
    readonly stitch: 1;
    readonly capture: 1;
    readonly spool: 1;
    readonly receipt: 1;
    readonly bundle: 1;
    readonly catalog: 3;
    readonly history: 1;
}>;
/** Fixed budgets; fault loss has no numerical ceiling under Q21. Legacy B's
 * spikeFaultMissingRows/unexpectedMarkedRowsPerPane are NOT flag-on gates. */
export declare const FLAGON_BUDGET: Readonly<{
    readonly processTreePssHardBytes: number;
    readonly plateauMinMs: number;
    readonly plateauMaxDeltaBytes: number;
    readonly normalMissingRows: 0;
    readonly plannedMissingRows: 0;
    readonly faultMissingRowsLimit: null;
    readonly tailSearchRows: 512;
    readonly searchChunkRows: 256;
    readonly retainedHistoryRows: 4500;
    readonly minAnchorRows: 8;
    readonly minDistinctKeys: 4;
    readonly minNonblankRows: 2;
    readonly maxCandidates: 4096;
    readonly stitchDeadlineMs: 100;
    readonly captureCountPerEpisode: 1;
    readonly rawBytesPerPane: number;
    readonly stagingBytesGlobal: number;
    readonly scratchBytes: number;
    readonly restoreCacheBytes: number;
    readonly archiveChunkBytes: number;
    readonly canaryRootCapBytes: number;
    readonly reserveBytes: number;
    readonly reservePerPaneBytes: number;
    readonly reserveSharedBytes: number;
    readonly archiveConcurrency: 1;
    readonly archivePollMs: 30000;
    readonly archiveStartFsPercent: 75;
    readonly archiveStartRootPercent: 75;
    readonly archiveStartTimeToFullMs: number;
    readonly archiveStopFsPercent: 70;
    readonly archiveStopRootPercent: 65;
    readonly archiveStopReserveMultiple: 2;
    readonly archiveStopTimeToFullMs: number;
    readonly criticalFsPercent: 90;
    readonly criticalRootPercent: 90;
    readonly criticalRateHorizonMs: number;
    readonly healthPollMs: 1000;
    readonly incidentDeadlineMs: 2000;
    readonly recoveryMs: 10000;
    readonly reconnectBackoffMs: readonly [100, 500, 1000, 2000];
}>;
export type SegmentRowId = NewarchRowId;
export type SegmentRowRange = NewarchRowRange;
export type Gap = NewarchGap;
export interface PipeEpoch {
    readonly pane: PaneKey;
    readonly attachId: string;
    readonly collectorIncarnation: string;
}
export interface RawPosition {
    readonly epoch: PipeEpoch;
    readonly byteOffset: number;
}
export interface RawRange {
    readonly epoch: PipeEpoch;
    readonly start: number;
    readonly end: number;
}
export type Coverage = readonly ({
    readonly kind: 'rows';
    readonly range: SegmentRowRange;
    readonly digest: Digest;
} | {
    readonly kind: 'gap';
    readonly gap: Gap;
    readonly digest: Digest;
})[];
export interface EvidenceFile {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: Digest;
}
export interface ProcessIdentity {
    readonly pid: number;
    readonly startTime: string;
    readonly bootId: string;
}
export interface OperationFence {
    readonly operationId: string;
    readonly pane: PaneKey;
    readonly expectedGeneration: number;
}
export interface AttachIntent extends OperationFence {
    readonly attachId: string;
    readonly episodeId: string;
    readonly parentEpisodeId: string | null;
    readonly kind: 'birth' | 'recovery';
    readonly rootUUID: string;
}
export interface CollectorBinding {
    readonly kind: 'collector-binding';
    readonly epoch: PipeEpoch;
    readonly attachId: string;
    readonly rootUUID: string;
    readonly bootNonce: string;
    readonly ownerGeneration: number;
    readonly process: ProcessIdentity;
    readonly peerUid: number;
    readonly fifoId: string;
    readonly handshakeId: string;
    readonly artifactSha256: Digest;
}
export type Binding = CollectorBinding;
/** Evidence must be checked against the actual binary/hooks/identity/geometry.
 * A caller-supplied boolean or matching content is never a boundary proof. */
export type BoundaryEvidence = {
    readonly kind: 'certified-same-turn';
    readonly pane: PaneKey;
    readonly epoch: PipeEpoch;
    readonly geometry: Geometry;
    readonly binarySha256: Digest;
    readonly hookConfigSha256: Digest;
    readonly transcript: EvidenceFile;
    readonly eventCoverage: EvidenceFile;
    readonly pipeOpenEvent: string;
    readonly captureStartEvent: string;
    readonly captureEndEvent: string;
    readonly rawStart: RawPosition;
    readonly certificateId: string;
} | {
    readonly kind: 'birth';
    readonly pane: PaneKey;
    readonly epoch: PipeEpoch;
    readonly genesis: VtCheckpoint;
    readonly firstByteOffset: 0;
    readonly transcript: EvidenceFile;
} | {
    readonly kind: 'overlap-unknown';
    readonly reason: 'wait' | 'hook' | 'split-command' | 'identity' | 'geometry' | 'command-error' | 'parse';
};
export interface CapturePacket {
    readonly version: 1;
    readonly snapshotId: string;
    readonly episodeId: string;
    readonly captureCount: 1;
    readonly complete: true;
    readonly pane: PaneKey;
    readonly geometry: Geometry;
    readonly geometryGeneration: number;
    readonly historySize: number;
    readonly historyLimit: number;
    readonly cursor: Cursor;
    readonly activeBuffer: 'normal' | 'alternate' | 'unknown';
    readonly mainHistory: 'available' | 'uncertain' | 'unavailable';
    readonly snapshot: EvidenceFile;
    readonly commandTranscript: EvidenceFile;
    readonly rawRange: RawRange;
    readonly boundary: BoundaryEvidence;
    readonly startedAtMonoMs: number;
    readonly endedAtMonoMs: number;
    readonly clockEpoch: string;
    readonly stateKnown: Readonly<Record<string, boolean>>;
}
/** No success variant for truncated capture. Birth can carry a certified empty
 * capture packet; no second capture is allowed after an uncertain crash. */
export interface OpenCapture {
    readonly packet: CapturePacket;
    readonly binding: Binding;
    readonly durable: SpoolAck;
}
export interface SourceTransportPort {
    openBirth(intent: AttachIntent, cancel: CancelToken): Promise<Result<OpenCapture>>;
    openRecovery(intent: AttachIntent, cancel: CancelToken): Promise<Result<OpenCapture>>;
}
export type RowOrigin = {
    readonly kind: 'durable';
    readonly rowId: SegmentRowId;
} | {
    readonly kind: 'capture';
    readonly snapshotId: string;
    readonly rowIndex: number;
} | {
    readonly kind: 'pipe';
    readonly range: RawRange;
    readonly ordinal: number;
};
export interface StitchRow {
    readonly origin: RowOrigin;
    readonly cells: readonly Cell[];
    readonly geometry: Geometry;
    readonly buffer: 'normal' | 'alternate';
    readonly wrapStatus: 'wrapped' | 'unwrapped' | 'unknown';
    readonly wrapPad: number;
    readonly finalized: boolean;
    readonly uncertainFields: readonly string[];
    readonly cellOrigins: readonly RowOrigin[];
}
export interface StitchWindow {
    readonly pane: PaneKey;
    readonly rows: readonly StitchRow[];
}
export interface CaptureWindow extends StitchWindow {
    readonly packet: CapturePacket;
}
export interface PipeWindow extends StitchWindow {
    readonly rawRange: RawRange;
}
export interface StitchPolicy {
    readonly version: 1;
    readonly minAnchorRows: 8;
    readonly minDistinctKeys: 4;
    readonly minNonblankRows: 2;
    readonly maxCandidates: 4096;
    readonly deadlineMs: 100;
}
export type SeamProof = {
    readonly kind: 'recorded-mapping';
    readonly range: RawRange;
    readonly checkpointId: string;
    readonly mapping: EvidenceFile;
    readonly coverage: Coverage;
} | {
    readonly kind: 'independent-boundary';
    readonly boundary: Exclude<BoundaryEvidence, {
        readonly kind: 'overlap-unknown';
    }>;
};
export interface StitchProofs {
    readonly policy: StitchPolicy;
    readonly episodeId: string;
    readonly tailToCapture: readonly SeamProof[];
    readonly captureToPipe: readonly SeamProof[];
}
export interface AcceptedRowMap {
    readonly source: RowOrigin;
    readonly target: SegmentRowId;
}
export interface WithheldRange {
    readonly source: 'tail' | 'capture' | 'pipe';
    readonly start: number;
    readonly end: number;
    readonly reason: 'ambiguous' | 'unproven' | 'unknown-state';
}
export interface StitchDecision {
    readonly decisionId: string;
    readonly acceptedRowMap: readonly AcceptedRowMap[];
    readonly withheldRanges: readonly WithheldRange[];
    readonly gaps: readonly Gap[];
}
export type StitchResult = (StitchDecision & {
    readonly status: 'matched';
    readonly proofs: StitchProofs;
}) | (StitchDecision & {
    readonly status: 'ambiguous';
    readonly reason: 'multiple-alignments' | 'candidate-limit';
    readonly candidateCount: number;
}) | (StitchDecision & {
    readonly status: 'unproven';
    readonly reason: 'content-only' | 'unknown-state' | 'geometry' | 'deadline' | 'short-anchor';
}) | {
    readonly status: 'error';
    readonly code: 'integrity' | 'identity' | 'io';
    readonly message: string;
};
export interface StitchPort {
    stitch(T: StitchWindow, C: CaptureWindow, P: PipeWindow, proofs: StitchProofs): Promise<StitchResult>;
}
export interface SpoolRecord {
    readonly version: 1;
    readonly operationId: string;
    readonly range: RawRange;
    readonly sequence: number;
    readonly previousDigest: Digest | null;
    readonly digest: Digest;
    readonly payload: {
        readonly kind: 'bytes';
        readonly bytes: readonly number[];
    } | {
        readonly kind: 'resize';
        readonly geometry: Geometry;
    } | {
        readonly kind: 'control';
        readonly name: string;
        readonly data: string;
    };
}
/** Issued only after sync; byte offsets are collector receive positions. */
export interface SpoolAck {
    readonly kind: 'synced-spool';
    readonly version: 1;
    readonly through: RawPosition;
    readonly recordDigest: Digest;
    readonly commitId: string;
    readonly segmentId: string;
}
export interface CommittedStreamRow extends StitchRow {
    readonly id: SegmentRowId;
}
export interface RowsAndGapsCommit extends OperationFence {
    readonly rows: readonly CommittedStreamRow[];
    readonly coverage: Coverage;
    readonly decision: StitchDecision;
    readonly inputAck: SpoolAck;
    readonly checkpointId: string | null;
    readonly digest: Digest;
}
export interface RowsAndGapsReceipt {
    readonly kind: 'rows-gaps-durable';
    readonly operationId: string;
    readonly commitId: string;
    readonly generation: number;
    readonly coverage: Coverage;
    readonly digest: Digest;
}
export type FlagOnRecoveryChunk = {
    readonly kind: 'input';
    readonly record: SpoolRecord;
    readonly ack: SpoolAck;
} | {
    readonly kind: 'committed';
    readonly rows: readonly CommittedStreamRow[];
    readonly gaps: readonly Gap[];
    readonly receipt: RowsAndGapsReceipt;
} | {
    readonly kind: 'checkpoint';
    readonly checkpoint: VtCheckpoint;
} | {
    readonly kind: 'truncated-tail';
    readonly discardedRange: RawRange;
    readonly lastAck: SpoolAck | null;
};
export interface PinRequest extends OperationFence {
    readonly segmentId: string;
    readonly reason: 'reader' | 'attach' | 'handoff' | 'replay' | 'checkpoint' | 'restore';
}
export interface SegmentPin extends PinRequest {
    readonly pinId: string;
    readonly durableCommitId: string;
}
export interface SealedExport {
    readonly kind: 'sealed-export';
    readonly operationId: string;
    readonly storeUUID: string;
    readonly pane: PaneKey;
    readonly segmentId: string;
    readonly generation: number;
    readonly coverage: Coverage;
    readonly files: readonly EvidenceFile[];
    readonly manifest: EvidenceFile;
    readonly sealCommitId: string;
}
export interface RemoteObject {
    readonly objectKey: string;
    readonly bytes: number;
    readonly sha256: Digest;
}
export interface ArchiveBundle {
    readonly version: 1;
    readonly bundleId: string;
    readonly storeUUID: string;
    readonly pane: PaneKey;
    readonly segmentId: string;
    readonly coverage: Coverage;
    readonly schemaVersions: Readonly<Record<string, number>>;
    readonly objects: readonly RemoteObject[];
    readonly manifest: RemoteObject;
    readonly members: readonly EvidenceFile[];
    readonly compression: 'tar.zst';
    readonly encryption: 'none';
    readonly checkpointIds: readonly string[];
    readonly rawRanges: readonly RawRange[];
}
export interface VerifiedBundle {
    readonly kind: 'verified-remote';
    readonly bundle: ArchiveBundle;
    readonly verificationId: string;
    readonly method: 'download-sha256' | 'rclone-check-download';
    readonly verifiedAtMonoMs: number;
    readonly clockEpoch: string;
    readonly inventoryDigest: Digest;
    readonly evidence: readonly EvidenceFile[];
    readonly toolVersion: string;
    readonly command: readonly string[];
    readonly stdout: EvidenceFile;
    readonly stderr: EvidenceFile;
    readonly exitCode: 0;
}
export interface RemoteIndexReceipt {
    readonly kind: 'remote-index-committed';
    readonly catalogVersion: 3;
    readonly commitId: string;
    readonly generation: number;
    readonly verified: VerifiedBundle;
    readonly coverage: Coverage;
}
export interface ReclaimReceipt {
    readonly kind: 'local-reclaimed';
    readonly remote: RemoteIndexReceipt;
    readonly removed: readonly EvidenceFile[];
    readonly allocatedBytesBefore: number;
    readonly allocatedBytesAfter: number;
    readonly freeBlocksBefore: number;
    readonly freeBlocksAfter: number;
    readonly blockBytes: number;
}
export interface FlagOnHistoryPort {
    appendInput(record: SpoolRecord): Promise<Result<SpoolAck>>;
    /** One durable transaction: rows + gaps + mapping/decision + checkpoint reference. */
    commitRowsAndGaps(request: RowsAndGapsCommit): Promise<Result<RowsAndGapsReceipt>>;
    recover(pane: PaneKey, after: RawPosition | null, cancel: CancelToken): AsyncIterable<Result<FlagOnRecoveryChunk>>;
    sealExport(request: OperationFence & {
        readonly segmentId: string;
    }): Promise<Result<SealedExport>>;
    pinSegment(request: PinRequest): Promise<Result<SegmentPin>>;
    releasePin(pin: SegmentPin): Promise<Result<null>>;
    /** Recheck pins AND generation in reclaim transaction. Never delete hot WAL. */
    reclaimVerified(request: OperationFence & {
        readonly sealed: SealedExport;
        readonly remote: RemoteIndexReceipt;
    }): Promise<Result<ReclaimReceipt>>;
}
export interface FiniteCut {
    readonly pane: PaneKey;
    readonly lastRow: SegmentRowId | null;
    readonly rawThrough: RawPosition;
}
export interface PhysicalIndexEntry {
    readonly coverageIndex: number;
    readonly fileId: string;
    readonly start: number;
    readonly end: number;
}
/** Exact batch is intentionally separate from appendCutoverSeal's overlap API. */
export interface ExactBatch extends OperationFence {
    readonly handoffId: string;
    readonly archiveIncarnation: string;
    readonly epochs: readonly PipeEpoch[];
    readonly cut: FiniteCut;
    readonly rows: readonly CommittedStreamRow[];
    readonly coverage: Coverage;
    readonly digest: Digest;
}
export interface LegacyRangeReceipt {
    readonly version: 1;
    readonly kind: 'legacy-range-durable';
    readonly operationId: string;
    readonly handoffId: string;
    readonly pane: PaneKey;
    readonly ownerGeneration: number;
    readonly epochs: readonly PipeEpoch[];
    readonly archiveIncarnation: string;
    readonly cut: FiniteCut;
    readonly coverage: Coverage;
    readonly coverageDigest: Digest;
    readonly physicalIndexMap: readonly PhysicalIndexEntry[];
    readonly files: readonly EvidenceFile[];
    readonly durableCommitId: string;
}
/** A validates by reading the receipt's exact row/gap coverage back from disk. */
export interface ValidatedLegacyReceipt {
    readonly kind: 'validated-legacy-receipt';
    readonly receipt: LegacyRangeReceipt;
    readonly validationId: string;
    readonly readbackDigest: Digest;
}
export interface WriterBindRequest extends OperationFence {
    readonly handoffId: string;
    readonly writer: ProcessIdentity;
    readonly leaseGeneration: number;
    readonly subscriptionId: string;
    readonly after: FiniteCut;
    readonly archiveIncarnation: string;
}
export interface WriterBinding extends WriterBindRequest {
    readonly kind: 'current-writer-binding';
    readonly bindingId: string;
    readonly handshakeId: string;
}
export interface SuffixPin {
    readonly kind: 'durable-suffix-pin';
    readonly cut: FiniteCut;
    readonly pin: SegmentPin;
    readonly through: SpoolAck;
    readonly checkpointId: string | null;
}
export interface LegacyWriterPort {
    appendExactBatch(batch: ExactBatch): Promise<Result<LegacyRangeReceipt>>;
    bindLegacyWriter(request: WriterBindRequest): Promise<Result<WriterBinding>>;
}
export type AttachState = 'ATTACH_INTENT' | 'PIPE_OPEN' | 'CAPTURED' | 'COMMITTED' | 'ABORTING' | 'ABORTED';
export interface AttachDecision {
    readonly attachId: string;
    readonly generation: number;
    readonly commitId: string;
    readonly state: AttachState;
    readonly admission: 'active-exact' | 'active-degraded' | null;
}
export interface CommitAttachRequest extends OperationFence {
    readonly attachId: string;
    readonly binding: Binding;
    readonly packet: CapturePacket;
    readonly durable: RowsAndGapsReceipt;
    readonly admission: 'active-exact' | 'active-degraded';
}
export type HandoffState = 'STREAM_ACTIVE' | 'HANDOFF_INTENT' | 'PREPARED' | 'DEST_DURABLE' | 'DEST_BOUND' | 'COMMITTED' | 'RELEASED';
export interface HandoffIntent extends OperationFence {
    readonly handoffId: string;
    readonly cut: FiniteCut;
}
export interface PreparedHandoff {
    readonly state: 'PREPARED';
    readonly intent: HandoffIntent;
    readonly prefix: Coverage;
    readonly pendingToken: NewarchHistoryCursor;
    readonly suffix: SuffixPin;
}
export interface CommitHandoffRequest {
    readonly prepared: PreparedHandoff;
    readonly receipt: ValidatedLegacyReceipt;
    readonly binding: WriterBinding;
    readonly suffix: SuffixPin;
}
export interface HandoffDecision {
    readonly state: 'COMMITTED' | 'RELEASED';
    readonly handoffId: string;
    readonly generation: number;
    readonly commitId: string;
    readonly receiptCommitId: string;
}
export type PendingRecovery = {
    readonly kind: 'pending';
    readonly prepared: PreparedHandoff;
    readonly reason: 'unverified-receipt' | 'writer-unbound' | 'suffix-unpinned' | 'storage';
} | {
    readonly kind: 'committed';
    readonly decision: HandoffDecision;
};
export type SegmentLocation = {
    readonly kind: 'local';
    readonly range: SegmentRowRange;
    readonly files: readonly EvidenceFile[];
} | {
    readonly kind: 'remote-required';
    readonly range: SegmentRowRange;
    readonly remote: RemoteIndexReceipt;
} | {
    readonly kind: 'restored';
    readonly range: SegmentRowRange;
    readonly cacheId: string;
    readonly remote: RemoteIndexReceipt;
} | {
    readonly kind: 'remote-unavailable';
    readonly range: SegmentRowRange;
    readonly bundleId: string;
    readonly reason: 'offline' | 'missing' | 'corrupt';
    readonly retryAfterMs: number;
};
export interface ArchiveCatalogPort {
    beginAttach(intent: AttachIntent): Promise<Result<AttachDecision>>;
    /** Must not abort a committed owner; only remove this attachId+generation. */
    abortAttach(request: OperationFence & {
        readonly attachId: string;
        readonly reason: string;
    }): Promise<Result<AttachDecision>>;
    commitAttach(request: CommitAttachRequest): Promise<Result<AttachDecision>>;
    prepareHandoff(intent: HandoffIntent, suffix: SuffixPin): Promise<Result<PreparedHandoff>>;
    /** Catalog atomically commits owner + segment + receipt ref + decision. */
    commitHandoff(request: CommitHandoffRequest): Promise<Result<HandoffDecision>>;
    recoverPending(pane: PaneKey, cancel: CancelToken): Promise<Result<PendingRecovery>>;
    commitRemoteIndex(request: OperationFence & {
        readonly sealed: SealedExport;
        readonly verified: VerifiedBundle;
    }): Promise<Result<RemoteIndexReceipt>>;
    getLocation(range: SegmentRowRange): Promise<Result<SegmentLocation>>;
}
export type ArchiveState = 'SEALED_LOCAL' | 'UPLOADING' | 'UPLOADED_UNVERIFIED' | 'VERIFIED_REMOTE' | 'REMOTE_COMMITTED' | 'LOCAL_RECLAIMED' | 'CORRUPT_REMOTE';
export interface StoragePressure {
    readonly sampledAtMonoMs: number;
    readonly clockEpoch: string;
    readonly filesystemUsedPercent: number | null;
    readonly rootAllocatedBytes: number;
    readonly rootHardCapBytes: number;
    readonly usableFreeBytes: number | null;
    readonly rate15minBytesPerSecond: number | null;
    readonly reserveBytes: number;
    readonly sampleAgeMs: number;
    readonly ioError: 'ENOSPC' | 'EIO' | null;
}
export interface ArchiveAttempt {
    readonly operationId: string;
    readonly state: ArchiveState;
    readonly bundleId: string;
    readonly retryAfterMs: number | null;
    readonly verified: VerifiedBundle | null;
    readonly reclaimed: ReclaimReceipt | null;
}
export interface RestoreRequest {
    readonly operationId: string;
    readonly storeUUID: string;
    readonly range: SegmentRowRange;
    readonly inventory: RemoteObject;
    readonly allowedRoot: string;
}
export interface RestoredRange {
    readonly kind: 'restored-immutable';
    readonly cacheId: string;
    readonly range: SegmentRowRange;
    readonly verified: VerifiedBundle;
    readonly files: readonly EvidenceFile[];
    readonly coverage: Coverage;
    readonly installCommitId: string;
}
export interface ArchiveWorkerPort {
    archiveOnce(pressure: StoragePressure, cancel: CancelToken): Promise<Result<ArchiveAttempt | {
        readonly state: 'idle';
        readonly reason: 'below-threshold' | 'pinned' | 'backoff';
    }>>;
    verifyBundle(bundle: ArchiveBundle, cancel: CancelToken): Promise<Result<VerifiedBundle>>;
    restoreRange(request: RestoreRequest, cancel: CancelToken): Promise<Result<RestoredRange>>;
}
/** Optional on old records; mandatory in the separate flag-on interfaces below. */
export interface ReadView {
    readonly flagOn?: FlagOnReadExtension;
}
export interface HistoryPage {
    readonly flagOn?: NewarchHistoryExtension;
}
export interface FlagOnReadExtension {
    readonly version: 1;
    readonly capabilities: NewarchCapabilities;
    readonly committedPrefix: Coverage;
    readonly cursor: NewarchHistoryCursor;
    readonly states: readonly NewarchHistoryState[];
}
export interface FlagOnReadView extends ReadView {
    readonly flagOn: FlagOnReadExtension;
}
export interface FlagOnHistoryPage {
    readonly view: FlagOnReadView;
    readonly rows: readonly CommittedStreamRow[];
    readonly payloadBytes: number;
    readonly flagOn: NewarchHistoryExtension;
}
export interface EpisodeObservation {
    readonly atMonoMs: number;
    readonly clockEpoch: string;
    readonly epoch: PipeEpoch;
    readonly episodeId: string;
    readonly phase: 'trigger' | 'resolve';
    readonly reason: string;
    readonly captureCount: number;
    readonly eventCoverage: number | null;
    readonly rawBytes: number;
    readonly gap: Gap | null;
    readonly rawRecoveredAtMonoMs: number | null;
    readonly exactDisplayAtMonoMs: number | null;
}
export interface ArchiveObservation {
    readonly atMonoMs: number;
    readonly clockEpoch: string;
    readonly epoch: PipeEpoch;
    readonly operationId: string;
    readonly state: ArchiveState;
    readonly physicalLocalBytes: number | null;
    readonly remoteVerifiedBytes: number | null;
    readonly spoolBytes: number | null;
    readonly scratchBytes: number | null;
    readonly cacheBytes: number | null;
    readonly pressure: StoragePressure;
}
export interface MemoryObservation {
    readonly atMonoMs: number;
    readonly clockEpoch: string;
    readonly epoch: PipeEpoch;
    readonly processes: readonly {
        readonly identity: ProcessIdentity;
        readonly role: 'host' | 'collector' | 'vt' | 'fifo' | 'archive' | 'observer';
        readonly pssBytes: number | null;
    }[];
    readonly expectedProcesses: readonly ProcessIdentity[];
    readonly coverage: number | null;
    readonly rawBytes: number;
    readonly stagingBytes: number;
    readonly physicalDiskBytes: number | null;
}
export interface FlagOnObserver {
    observeEpisode(observation: EpisodeObservation): void;
    observeArchive(observation: ArchiveObservation): void;
    observeMemory(observation: MemoryObservation): void;
}
/** Non-operational placeholder only. There is deliberately no default runtime. */
export declare function flagOnNotImplemented(port: string): never;
export declare const FLAGON_REPAIR_REVISION: 2;
export declare const FLAGON_REPAIR_LIMITS: Readonly<{
    readonly receiptSetEntries: 256;
    readonly chunkRows: 256;
    readonly chunkBytes: number;
    readonly receiptSetBytes: number;
    readonly readEntries: 256;
    readonly readBytes: number;
}>;
/** Semantic decoder style, NEVER Cell.style. attrs bits 0..8 = SGR 1..9,
 * bit 9 = SGR 21. fg/bg: -1 default, 0..255 index, 256+0xRRGGBB RGB.
 * Unsupported attributes fail, they are never silently discarded. */
export interface SemanticStyle {
    readonly attrs: number;
    readonly fg: number;
    readonly bg: number;
}
export interface SemanticCell {
    readonly text: string;
    readonly width: 0 | 1 | 2;
    readonly style: SemanticStyle;
}
export declare function semanticStyleToSgr(style: SemanticStyle): number[];
/** Accept canonical full-state parameters only (implicit reset before each
 * cell). [] = default. Reject reset/off codes, aliases, duplicates, reordered
 * params and unknown SGR; parsing arbitrary ANSI is the decoder's job. */
export declare function sgrToSemanticStyle(sgr: readonly number[]): SemanticStyle;
export declare function semanticCellToCell(cell: SemanticCell): Cell;
export declare function cellToSemanticCell(cell: Cell): SemanticCell;
/** Normalized projection uses W's existing v1 formula; old H receipts retain
 * their original digest. H emits a separately stored CoverageProjectionR2. */
export declare function normalizedRowsDigest(range: SegmentRowRange, rows: readonly CommittedStreamRow[]): Digest;
export declare function normalizedGapDigest(gap: Gap): Digest;
export declare function normalizedCoverageDigest(coverage: Coverage): Digest;
export interface CoverageProjectionR2 {
    readonly revision: 2;
    readonly sourceCommitId: string;
    readonly sourceDigest: Digest;
    readonly sourceDomain: 'rows-gaps-v1';
    readonly coverage: Coverage;
    readonly coverageDigest: Digest;
    readonly projectionDigest: Digest;
}
export declare function coverageProjectionDigest(proof: Omit<CoverageProjectionR2, 'projectionDigest'>): Digest;
export interface LegacyReadbackR2 {
    readonly kind: 'legacy-readback-r2';
    readonly revision: 2;
    readonly receiptCommitId: string;
    readonly coverageDigest: Digest;
    readonly readbackDigest: Digest;
}
export interface PhysicalReadbackR2 {
    readonly durableCommitId: string;
    readonly coverageDigest: Digest;
    readonly files: readonly EvidenceFile[];
    readonly physicalIndexMap: readonly PhysicalIndexEntry[];
    /** SHA-256(JSON.stringify(lines)) per ordered coverage entry, after disk read. */
    readonly lineSha: readonly Digest[];
}
export declare function physicalReadbackDigest(readback: PhysicalReadbackR2): Digest;
/** Equality of a claimed proof and W's authoritative synchronous disk read.
 * NOT an authority by itself: passing the claim twice proves nothing. A must
 * additionally validate receipt identity/coverage/current binding/suffix pin. */
export declare function legacyReadbackMatches(claimed: LegacyReadbackR2, authority: LegacyReadbackR2): boolean;
export interface SourceChainSliceR2 {
    readonly range: RawRange;
    readonly firstSequence: number;
    readonly lastSequence: number;
    readonly previousDigest: Digest | null;
    readonly terminalDigest: Digest;
    readonly sourceDomain: 'spool-record';
    readonly recordsDigest: Digest;
}
export interface CoalescedInputR2 {
    readonly revision: 2;
    readonly record: SpoolRecord;
    readonly historyDomain: 'spool';
    readonly source: readonly SourceChainSliceR2[];
    readonly provenanceDigest: Digest;
}
export declare function sourceSpoolDigest(record: Omit<SpoolRecord, 'digest'>): Digest;
export declare function historySpoolDigest(record: Omit<SpoolRecord, 'digest'>): Digest;
export declare function inputProvenanceDigest(input: Omit<CoalescedInputR2, 'provenanceDigest'>): Digest;
export interface AttachReceiptEntryR2 {
    readonly ordinal: number;
    readonly operationId: string;
    readonly commitId: string;
    readonly digest: Digest;
    readonly rows: number;
    readonly payloadBytes: number;
}
export interface AttachReceiptSetR2 {
    readonly revision: 2;
    readonly transactionId: string;
    readonly pane: PaneKey;
    readonly epoch: PipeEpoch;
    readonly decisionId: string;
    readonly expectedGeneration: number;
    readonly entries: readonly AttachReceiptEntryR2[];
    readonly terminalCommitId: string;
    readonly aggregateDigest: Digest;
}
export declare function attachReceiptSetDigest(entries: readonly AttachReceiptEntryR2[]): Digest;
/** Structural conformance only. A MUST resolve every receipt through H's
 * read authority and compare staged transaction/epoch/decision before publish.
 * Bound entire set and return in order, never select one terminal/gap receipt. */
export declare function attachCoverage(set: AttachReceiptSetR2, receipts: readonly RowsAndGapsReceipt[]): Coverage;
export interface StagedRowsR2 extends RowsAndGapsCommit {
    readonly repair: {
        readonly revision: 2;
        readonly transactionId: string;
        readonly epoch: PipeEpoch;
        readonly decisionId: string;
        readonly chunkOrdinal: number;
        readonly visibility: 'candidate';
    };
}
export interface StagedReceiptR2 {
    readonly request: StagedRowsR2['repair'];
    readonly receipt: RowsAndGapsReceipt;
    readonly projection: CoverageProjectionR2;
}
export interface CommitAttachR2 extends Omit<CommitAttachRequest, 'durable'> {
    readonly receiptSet: AttachReceiptSetR2;
}
export interface AttachDecisionR2 extends AttachDecision {
    readonly revision: 2;
    readonly transactionId: string;
    readonly receiptSetDigest: Digest;
}
export interface ArchiveMemberMappingR2 {
    readonly sourcePath: string;
    readonly relativePath: string;
    readonly bytes: number;
    readonly sha256: Digest;
}
export interface ArchiveInventoryR2 {
    readonly revision: 2;
    readonly sealGeneration: number;
    readonly sealCommitId: string;
    readonly sealManifestSha256: Digest;
    readonly bundleManifestSha256: Digest;
    readonly members: readonly ArchiveMemberMappingR2[];
}
export declare function archiveInventoryMatches(seal: SealedExport, bundle: ArchiveBundle, inventory: ArchiveInventoryR2): boolean;
export interface SegmentContinuityR2 {
    readonly revision: 2;
    readonly pane: PaneKey;
    readonly epoch: PipeEpoch;
    readonly predecessor: string;
    readonly successor: string;
    readonly boundary: RawPosition;
    readonly lastRow: SegmentRowId | null;
    readonly firstSuccessorOrdinal: 0;
    readonly sealCommitId: string;
    readonly rotationCommitId: string;
    readonly digest: Digest;
}
export declare function segmentContinuityDigest(value: Omit<SegmentContinuityR2, 'digest'>): Digest;
export interface OrderedControlR2 {
    readonly revision: 2;
    readonly eventId: string;
    readonly position: RawPosition;
    /** Strictly increasing at the same raw offset; bytes after it use new state. */
    readonly order: number;
    readonly decoderVersion: string;
    readonly payload: {
        readonly kind: 'geometry';
        readonly before: Geometry;
        readonly after: Geometry;
    } | {
        readonly kind: 'control';
        readonly name: string;
        readonly data: string;
    };
    readonly digest: Digest;
}
export declare function orderedControlDigest(value: Omit<OrderedControlR2, 'digest'>): Digest;
/** R12: bounded read of the durable control journal strictly after a replay
 * watermark, in (byteOffset, order) order within the watermark's epoch. Opaque
 * cursor continues the same read; it never re-derives order from a decoder. */
export interface OrderedControlReadR2 {
    readonly pane: PaneKey;
    readonly after: ReplayWatermarkR2;
    readonly cursor: NewarchHistoryCursor | null;
    readonly maxEntries: number;
    readonly maxBytes: number;
}
export interface OrderedControlEntryR2 {
    readonly commitId: string;
    readonly event: OrderedControlR2;
}
/** payloadBytes = UTF-8 bytes of streamCanonical(entries). next === null iff
 * atDurableHead; a non-head page with no entries is a stalled read, not EOF. */
export interface OrderedControlPageR2 {
    readonly revision: 2;
    readonly pane: PaneKey;
    readonly checkpointId: string;
    readonly entries: readonly OrderedControlEntryR2[];
    readonly payloadBytes: number;
    readonly next: NewarchHistoryCursor | null;
    readonly atDurableHead: boolean;
}
/** Replay position carried between pages: last applied control (null before
 * the first page) and the geometry in force, seeded from checkpoint.state. */
export interface OrderedControlReplayR2 {
    readonly last: OrderedControlR2 | null;
    readonly geometry: Geometry;
}
/** Structural conformance of one page against the request and the carried
 * replay position. Returns the events to apply and the geometry after them.
 * Not durability proof: H answers from its journal, I applies before bytes. */
export declare function replayOrderedControls(request: OrderedControlReadR2, page: OrderedControlPageR2, carried: OrderedControlReplayR2): OrderedControlReplayR2 & {
    readonly events: readonly OrderedControlR2[];
};
export interface ReplayWatermarkR2 {
    readonly revision: 2;
    readonly pane: PaneKey;
    readonly checkpointId: string;
    readonly through: RawPosition;
    readonly controlOrder: number;
    readonly decoderVersion: string;
    readonly stateDigest: Digest;
    readonly known: Readonly<Record<string, boolean>>;
    readonly decisionIndexCommitId: string;
    readonly snapshotDependencies: readonly EvidenceFile[];
    readonly durableCommitId: string;
}
/** Persistent interval decisions, never regenerated from a resized decoder's
 * scroll ordinal. Keep metadata after payload reclaim; page it in <=256 items. */
export interface ReplayDecisionR2 {
    readonly decisionId: string;
    readonly raw: RawRange;
    readonly controlStart: number;
    readonly controlEnd: number;
    readonly disposition: 'consumed' | 'withheld';
    readonly coverage: Coverage;
    readonly checkpointId: string;
    readonly decoderVersion: string;
}
export interface TimelineHeadR2 {
    readonly pane: PaneKey;
    readonly generation: number;
    readonly indexCommitId: string;
    readonly entryCount: number;
    readonly rowCount: number;
    readonly lastRow: SegmentRowId | null;
    readonly cursor: NewarchHistoryCursor;
}
export type TailAnchorR2 = {
    readonly kind: 'genesis';
    readonly birth: BirthCertificateR2;
} | {
    readonly kind: 'local';
    readonly head: TimelineHeadR2;
    readonly rows: readonly CommittedStreamRow[];
    readonly pin: SegmentPin;
} | {
    readonly kind: 'blocked';
    readonly head: TimelineHeadR2;
    readonly state: NewarchHistoryState;
};
export interface TimelinePageR2 {
    readonly head: TimelineHeadR2;
    readonly entries: readonly (CommittedStreamRow | Gap)[];
    readonly payloadBytes: number;
    readonly before: import('../core/index.js').NewarchHistoryContinuation;
    readonly after: import('../core/index.js').NewarchHistoryContinuation;
}
export interface BoundedReadR2 {
    readonly pane: PaneKey;
    readonly cursor: NewarchHistoryCursor | null;
    readonly direction: 'before' | 'after';
    readonly maxEntries: number;
    readonly maxBytes: number;
}
/** Synchronous calls return bounded durable data from H, not host SQL. H must
 * coordinate retention pins/read views; Result failure is never a missing row.
 * `null` is a successful authoritative absence, distinct from I/O failure. */
export interface HistoryAuthorityR2 {
    generation(pane: PaneKey): Result<number>;
    staged(transactionId: string, ordinal: number): Result<StagedReceiptR2 | null>;
    receipt(commitId: string): Result<RowsAndGapsReceipt | null>;
    pin(pinId: string): Result<SegmentPin | null>;
    seal(sealCommitId: string): Result<SealedExport | null>;
    continuity(rotationCommitId: string): Result<SegmentContinuityR2 | null>;
    head(pane: PaneKey): Result<TimelineHeadR2>;
    tail(pane: PaneKey, maxRows: number, maxBytes: number): Result<TailAnchorR2>;
    page(request: BoundedReadR2): Result<TimelinePageR2>;
    watermark(pane: PaneKey): Result<ReplayWatermarkR2 | null>;
    decisions(request: BoundedReadR2): Result<{
        readonly entries: readonly ReplayDecisionR2[];
        readonly next: NewarchHistoryCursor | null;
    }>;
    /** R12: journaled controls after `request.after`, survives restart/reclaim. */
    controls(request: OrderedControlReadR2): Result<OrderedControlPageR2>;
}
export interface ConsumerCheckpointR2 extends OperationFence {
    readonly revision: 2;
    readonly consumerId: string;
    readonly through: SpoolAck;
    readonly replayFloor: RawPosition;
    readonly watermark: ReplayWatermarkR2;
    readonly pins: readonly SegmentPin[];
    readonly recovery: {
        readonly kind: 'successor-checkpoint';
        readonly checkpoint: ReplayWatermarkR2;
        readonly retentionCommitId: string;
    } | {
        readonly kind: 'verified-archive';
        readonly remote: RemoteIndexReceipt;
    };
}
export interface TrimReceiptR2 {
    readonly revision: 2;
    readonly commitId: string;
    readonly epoch: PipeEpoch;
    readonly floor: RawPosition;
    readonly lastSequence: number;
    readonly lastDigest: Digest;
    readonly checkpoint: ConsumerCheckpointR2;
    readonly allocatedBytesBefore: number;
    readonly allocatedBytesAfter: number;
}
export type SpoolReadR2 = {
    readonly kind: 'records';
    readonly records: readonly SpoolRecord[];
    readonly next: RawPosition;
    readonly atDurableHead: boolean;
} | {
    readonly kind: 'below-floor';
    readonly requested: RawPosition;
    readonly retained: TrimReceiptR2;
};
export interface CollectorArtifactR2 {
    readonly artifactSha256: Digest;
    readonly protocolVersion: number;
    readonly schemaVersion: number;
    readonly capabilities: readonly string[];
    readonly runtimeProof: EvidenceFile;
}
export interface CollectorNegotiationR2 {
    readonly revision: 2;
    readonly binding: Binding;
    readonly running: CollectorArtifactR2;
    readonly allowed: readonly CollectorArtifactR2[];
}
/** Hash alone is insufficient. Candidate allowlist and live runtime identity
 * are checked by S/I; unknown required capabilities refuse before pipe change. */
export interface BirthCertificateR2 {
    readonly revision: 2;
    readonly creationId: string;
    readonly pane: PaneKey;
    readonly epoch: PipeEpoch;
    readonly command: 'new-session' | 'new-window' | 'split-window';
    readonly binarySha256: Digest;
    readonly hooksSha256: Digest;
    readonly transcript: EvidenceFile;
    readonly eventCoverage: EvidenceFile;
    readonly nonWaitingCommandEvents: readonly string[];
    readonly rawStart: RawPosition;
    readonly genesis: VtCheckpoint;
}
export interface ReadyRetirementR2 extends OperationFence {
    readonly revision: 2;
    readonly binding: Binding;
    readonly attachId: string;
    readonly decision: AttachDecisionR2;
    readonly incident: import('../core/index.js').NewarchIncidentR2;
}
export interface SourceTransportR2 extends SourceTransportPort {
    negotiate(request: CollectorNegotiationR2): Promise<Result<CollectorArtifactR2>>;
    acknowledgeConsumer(request: ConsumerCheckpointR2): Promise<Result<ConsumerCheckpointR2>>;
    trim(request: ConsumerCheckpointR2): Promise<Result<TrimReceiptR2>>;
    replayBounded(binding: Binding, after: RawPosition, maxRecords: number, maxBytes: number): Promise<Result<SpoolReadR2>>;
    retireReady(request: ReadyRetirementR2): Promise<Result<{
        readonly commitId: string;
        readonly binding: Binding;
    }>>;
    rearmReserve(request: OperationFence & {
        readonly incidentId: string;
        readonly resolvedCommitId: string;
    }): Promise<Result<{
        readonly commitId: string;
        readonly physicalFreeBytes: number;
    }>>;
    certifyBirth(creationId: string, binding: Binding): Promise<Result<BirthCertificateR2>>;
}
export interface FlagOnHistoryR2 extends FlagOnHistoryPort {
    readonly authority: HistoryAuthorityR2;
    appendVerifiedInput(input: CoalescedInputR2): Promise<Result<SpoolAck>>;
    stageRows(request: StagedRowsR2): Promise<Result<StagedReceiptR2>>;
    /** H reconciles catalog decision before exposing rows. This is idempotent
     * finalization, not a second owner decision. Lost ACK queries A first. */
    publishAttach(decision: AttachDecisionR2): Promise<Result<TimelineHeadR2>>;
    discardAttach(decision: AttachDecisionR2): Promise<Result<null>>;
    rotateSegment(request: OperationFence & {
        readonly segmentId: string;
        readonly boundary: RawPosition;
    }): Promise<Result<SegmentContinuityR2>>;
    /** Separate bounded scratch export from logical seal/rotation. */
    materializeExport(request: OperationFence & {
        readonly sealCommitId: string;
    }): Promise<Result<SealedExport>>;
    journalControl(request: OperationFence & {
        readonly event: OrderedControlR2;
    }): Promise<Result<{
        readonly commitId: string;
        readonly event: OrderedControlR2;
    }>>;
    commitReplayCheckpoint(request: OperationFence & {
        readonly checkpoint: VtCheckpoint;
        readonly watermark: ReplayWatermarkR2;
    }): Promise<Result<ReplayWatermarkR2>>;
    commitReplayDecision(request: OperationFence & {
        readonly decision: ReplayDecisionR2;
    }): Promise<Result<{
        readonly commitId: string;
    }>>;
}
export interface FrozenLegacyIntervalR2 extends OperationFence {
    readonly revision: 2;
    readonly intervalId: string;
    readonly from: FiniteCut;
    readonly cut: FiniteCut;
    readonly receipt: LegacyRangeReceipt;
    readonly readback: LegacyReadbackR2;
    readonly binding: WriterBinding;
    readonly suffix: SuffixPin;
    readonly freezeCommitId: string;
}
export interface SamePipeSwitchR2 extends OperationFence {
    readonly revision: 2;
    readonly switchId: string;
    readonly interval: FrozenLegacyIntervalR2;
    readonly binding: Binding;
    readonly to: 'newarch';
}
export interface SamePipeDecisionR2 {
    readonly revision: 2;
    readonly switchId: string;
    readonly commitId: string;
    readonly generation: number;
    readonly cut: FiniteCut;
    readonly binding: Binding;
}
export type PendingRecoveryR2 = {
    readonly kind: 'none';
} | {
    readonly kind: 'legacy-unverified-pending';
    readonly sourceVersion: 1 | 2;
    readonly pendingId: string;
    readonly pane: PaneKey;
    readonly original: EvidenceFile;
    readonly readablePrefix: Coverage;
    readonly cursor: NewarchHistoryCursor;
} | {
    readonly kind: 'prepared';
    readonly prepared: PreparedHandoff;
    readonly reason: 'unverified-receipt' | 'writer-unbound' | 'suffix-unpinned' | 'storage';
} | {
    readonly kind: 'committed';
    readonly decision: HandoffDecision;
} | {
    readonly kind: 'error';
    readonly code: 'integrity' | 'io' | 'unsupported';
    readonly message: string;
};
export interface RemoteAuthorizationR2 extends OperationFence {
    readonly revision: 2;
    readonly sealed: SealedExport;
    readonly inventory: ArchiveInventoryR2;
    readonly verified: VerifiedBundle;
}
export interface RemoteIndexR2 extends RemoteIndexReceipt {
    readonly repair: {
        readonly revision: 2;
        readonly sealCommitId: string;
        readonly sealGeneration: number;
        readonly inventoryDigest: Digest;
        readonly authorizationGeneration: number;
    };
}
/** H consults this synchronously INSIDE its reclaim transaction and rechecks
 * its current generation/pins. O's journal is never a substitute for A. */
export interface CatalogAuthorityR2 {
    attach(attachId: string): Result<AttachDecisionR2 | null>;
    remote(commitId: string): Result<RemoteIndexR2 | null>;
}
export interface ArchiveCatalogR2 extends Omit<ArchiveCatalogPort, 'commitAttach' | 'recoverPending' | 'commitRemoteIndex'> {
    readonly authority: CatalogAuthorityR2;
    commitAttach(request: CommitAttachR2): Promise<Result<AttachDecisionR2>>;
    recoverPending(pane: PaneKey, cancel: CancelToken): Promise<Result<PendingRecoveryR2>>;
    commitHandoffR2(request: CommitHandoffRequest & {
        readonly readback: LegacyReadbackR2;
    }): Promise<Result<HandoffDecision>>;
    switchSamePipe(request: SamePipeSwitchR2): Promise<Result<SamePipeDecisionR2>>;
    commitRemoteIndex(request: RemoteAuthorizationR2): Promise<Result<RemoteIndexR2>>;
    resolveLegacyPending(request: OperationFence & {
        readonly pendingId: string;
        readonly handoff: CommitHandoffRequest;
        readonly readback: LegacyReadbackR2;
    }): Promise<Result<HandoffDecision>>;
}
export interface LegacyWriterR2 extends LegacyWriterPort {
    /** Must read actual durable commit/files/index/lines, independently of claim. */
    readback(receipt: LegacyRangeReceipt): Result<LegacyReadbackR2>;
    projection(commitId: string): Result<CoverageProjectionR2 | null>;
    freezeInterval(request: OperationFence & {
        readonly intervalId: string;
        readonly from: FiniteCut;
        readonly cut: FiniteCut;
        readonly binding: WriterBinding;
        readonly suffix: SuffixPin;
    }): Promise<Result<FrozenLegacyIntervalR2>>;
    appendContinuous(request: ExactBatch & {
        readonly continuity: readonly SegmentContinuityR2[];
    }): Promise<Result<LegacyRangeReceipt>>;
}
export interface ArchiveBundleR2 extends ArchiveBundle {
    readonly repair: {
        readonly revision: 2;
        readonly inventory: ArchiveInventoryR2;
        readonly timelineIndex: EvidenceFile;
        readonly replayIndex: EvidenceFile;
    };
}
export interface RestoreAuthorityR2 {
    lookup(range: SegmentRowRange): Result<SegmentLocation>;
    page(request: BoundedReadR2): Result<TimelinePageR2>;
    pin(request: PinRequest): Promise<Result<SegmentPin>>;
    release(pin: SegmentPin): Promise<Result<null>>;
}
export type GapR2 = import('../core/index.js').NewarchGapR2;
/** Legacy identity is isolated in its own namespace; never add an r2 identity
 * to an old serialized gap or recalculate its durable digest during migration. */
export declare function gapIdentity(gap: Gap | GapR2): string;
export declare function validGapUpdate(previous: GapR2, next: GapR2): boolean;
export interface LogicalSealR2 {
    readonly revision: 2;
    readonly sealCommitId: string;
    readonly sealGeneration: number;
    readonly pane: PaneKey;
    readonly segmentId: string;
    readonly coverage: Coverage;
    readonly rawRanges: readonly RawRange[];
    readonly checkpointIds: readonly string[];
    readonly timelineIndexCommitId: string;
    readonly replayIndexCommitId: string;
}
export interface FlagOnHistoryR2 {
    sealSegment(request: OperationFence & {
        readonly segmentId: string;
    }): Promise<Result<LogicalSealR2>>;
    listSealed(cursor: string | null, limit: number): Result<{
        readonly seals: readonly LogicalSealR2[];
        readonly next: string | null;
    }>;
    /** Verify remote via CatalogAuthorityR2 inside the transaction, together with
     * current generation and all pins; never trust the passed receipt alone. */
    reclaimR2(request: OperationFence & {
        readonly sealed: SealedExport;
        readonly remote: RemoteIndexR2;
        readonly inventory: ArchiveInventoryR2;
    }): Promise<Result<ReclaimReceipt>>;
}
export declare function archiveInventoryDigest(inventory: ArchiveInventoryR2): Digest;
export interface HistoryAuthorityR2 {
    /** Present only after sealAttachSet verifies every staged chunk and prevents
     * further staging. A compares this durable manifest with its request. */
    attachSet(transactionId: string): Result<AttachReceiptSetR2 | null>;
}
export interface FlagOnHistoryR2 {
    sealAttachSet(request: OperationFence & {
        readonly manifest: AttachReceiptSetR2;
    }): Promise<Result<AttachReceiptSetR2>>;
}
export interface CatalogAuthorityR2 {
    switchDecision(switchId: string): Result<SamePipeDecisionR2 | null>;
}
export declare function sourceRecordsDigest(records: readonly SpoolRecord[]): Digest;
import type { NewarchV2PaneDescriptor, NewarchV2SessionKey, NewarchV2FixedGeometry, NewarchV2Incident, NewarchV2HistoryCursor, NewarchV2HistoryRequest, NewarchV2ReadState, NewarchV2Continuation } from '../core/index.js';
export type { NewarchV2PaneDescriptor, NewarchV2SessionKey, NewarchV2FixedGeometry, NewarchV2Incident, NewarchV2HistoryCursor, NewarchV2HistoryRequest, } from '../core/index.js';
export declare const NEWARCH_V2_VERSION: "newarch-v2";
export declare const NEWARCH_V2_LIMITS: Readonly<{
    readonly maxColumns: 240;
    readonly maxRows: 120;
    readonly maxActivePanes: 21;
    readonly maxIdentityBytes: 256;
    readonly pendingRowsPerPane: 256;
    readonly pendingBytesPerPane: number;
    readonly pendingDeadlineMs: 1000;
    readonly vtBytesPerPane: number;
    readonly checkpointBytesPerPane: number;
    readonly auditQueueEntries: 21;
    readonly diagnosticEventBytes: number;
    readonly diagnosticTotalBytes: number;
    readonly pageEntries: 256;
    readonly pageBytes: number;
    readonly cursorBytes: 4096;
    readonly processTreePssHardBytes: number;
    readonly plateauMinMs: number;
    readonly pssWindowMs: number;
    readonly pssWarmupMs: number;
    readonly pssSampleMs: 1000;
    readonly pssTransientSampleMs: 100;
    readonly pssSlopeMiBPerHour: 10;
    readonly pssMeanDeltaMiB: 10;
    readonly pssMeanWindowsMinutes: readonly (readonly number[])[];
    readonly rowRates: readonly number[];
    readonly normalMissingRows: 0;
}>;
export declare const NEWARCH_V2_AUDIT_TRIGGERS: readonly ["uncertain-rule", "decoder-anomaly", "checkpoint-mismatch", "resume"];
export type V2AuditTrigger = typeof NEWARCH_V2_AUDIT_TRIGGERS[number];
export interface V2AuditConfig {
    readonly enabled: boolean;
    readonly intervalMs: number;
    readonly jitterFraction: number;
    readonly triggers: readonly V2AuditTrigger[];
    readonly minGapMs: number;
    readonly maxConcurrent: number;
    readonly timeoutMs: number;
    readonly maxCaptureBytes: number;
    readonly maxRetries: number;
}
/** rootCap includes reserve; dataBudget = rootCap-reserve. Scratch/staging and
 * diagnostic allocations are DATA, not extra deductions from this budget.
 * Measure allocated filesystem bytes (DB+WAL+SHM, raw+journals, staging/restore,
 * diagnostics); count each inode once, including temp files. All producers
 * reserve allocation in the SAME ledger before write, even while host is down.
 * Defaults are the existing 256 MiB canary cap, not a 21-pane sizing claim.
 * S/H/O must share the same config digest. Test caps are fixed before admission. */
export interface V2StorageBudget {
    readonly rootCapBytes: number;
    readonly emergencyReserveBytes: number;
    readonly reservePerPaneBytes: number;
    readonly reserveSharedBytes: number;
    readonly diagnosticCapBytes: number;
    readonly stagingCapBytes: number;
}
export interface V2Config {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly configVersion: string;
    readonly geometry: Geometry;
    readonly maxActivePanes: number;
    readonly rules: readonly {
        readonly ruleId: string;
        readonly version: string;
    }[];
    readonly audit: V2AuditConfig;
    readonly storage: V2StorageBudget;
}
export declare const NEWARCH_V2_DEFAULT_CONFIG: V2Config;
export declare function v2PaneKey(p: PaneKey): string;
export declare function v2SessionKey(s: NewarchV2SessionKey): string;
export declare function v2Digest(kind: string, payload: unknown, encode?: (value: unknown) => string): Digest;
export declare function validateV2Config(c: V2Config): void;
/** Return a detached immutable birth geometry. Editing config only affects new
 * births; no reflow or geometry epoch migration exists in v2. */
export declare function v2BirthGeometry(c: V2Config): NewarchV2FixedGeometry;
export interface V2StorageUsage {
    readonly databaseBytes: number;
    readonly rawBytes: number;
    readonly stagingBytes: number;
    readonly diagnosticBytes: number;
    readonly reservedDataBytes: number;
    readonly reserveAllocatedBytes: number;
}
export declare function v2StorageAllowance(c: V2Config, u: V2StorageUsage): {
    readonly dataBudgetBytes: number;
    readonly dataUsedBytes: number;
    readonly availableDataBytes: number;
};
/** HS2: a named storage profile is the budget a root is born with. The
 * allocation manifest splits the data budget (rootCap-reserve) per class for
 * the WHOLE root (all panes share it); null keeps the legacy shared budget
 * where the database gets half of the data budget. V2StorageBudget itself is
 * unchanged: validateV2Config walks its values, so a new field there breaks. */
export type V2AllocationClass = 'database' | 'wal' | 'raw' | 'staging' | 'diagnostic' | 'other';
export interface V2AllocationManifest {
    readonly databaseBytes: number;
    readonly walBytes: number;
    readonly rawBytes: number;
    readonly stagingBytes: number;
    readonly diagnosticBytes: number;
    readonly otherBytes: number;
}
export interface V2StorageProfile {
    readonly name: string;
    readonly storage: V2StorageBudget;
    readonly allocation: V2AllocationManifest | null;
}
export declare const NEWARCH_V2_STORAGE_PROFILES: {
    readonly 'default-256m': V2StorageProfile;
    readonly 'r-canary-8g': V2StorageProfile;
};
/** Callers that pass no profile keep exactly the pre-HS2 budget. */
export declare function v2LegacyStorageProfile(storage: V2StorageBudget): V2StorageProfile;
export declare function validateV2StorageProfile(p: V2StorageProfile, c: V2Config): void;
/** Binds what a root may hold (storage + allocation), not its name and not
 * geometry/rules/configVersion: editing those must still reopen the root. */
export declare function v2StorageProfileDigest(p: V2StorageProfile): Digest;
/** SQLite max_page_count for H at the root's REAL page size. Legacy keeps
 * half of the data budget for the database so DB + WAL fit (default at
 * 4096 B pages: 30,720 pages, the pre-HS2 value). */
export declare function v2DatabasePageLimit(p: V2StorageProfile, pageSize: number): number;
/** One ledger per ROOT. Pure admission only: making it durable and shared by
 * S and H across processes (host down included) belongs to HS3. */
export interface V2AllocationLedger {
    readonly version: number;
    readonly used: Readonly<Record<V2AllocationClass, number>>;
    readonly reserveUsedBytes: number;
}
export type V2AllocationRequest = {
    readonly expectedVersion: number;
    readonly cls: V2AllocationClass | 'emergency';
    readonly bytes: number;
};
export declare function v2AllocationReserve(p: V2StorageProfile, l: V2AllocationLedger, r: V2AllocationRequest): {
    readonly ok: true;
    readonly ledger: V2AllocationLedger;
} | {
    readonly ok: false;
    readonly reason: 'stale-ledger' | 'class-cap' | 'data-budget' | 'reserve';
};
/** unknown = owner store unreadable/incomplete OR identity not revalidated
 * after await. Never treat it as absence. legacy requires authoritative proof
 * of exclusion from the NEWARCH session account, including raw-created panes. */
export type V2OwnerLookup = {
    readonly kind: 'legacy';
    readonly session: NewarchV2SessionKey;
} | {
    readonly kind: 'capture-engine';
    readonly pane: NewarchV2PaneDescriptor;
} | {
    readonly kind: 'unknown';
    readonly reason: 'unloaded' | 'io' | 'corrupt' | 'identity';
};
export declare function v2LegacyAppendAllowed(owner: V2OwnerLookup, current: NewarchV2SessionKey): boolean;
export interface V2OwnerRecord {
    readonly pane: NewarchV2PaneDescriptor;
    readonly generation: number;
    readonly durableRevision: number;
    readonly frontier: SegmentRowId | null;
    readonly incidentId: string | null;
    readonly binding: Binding | null;
}
export interface V2BirthIntent {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly operationId: string;
    readonly session: NewarchV2SessionKey;
    readonly geometry: NewarchV2FixedGeometry;
    readonly command: 'new-session' | 'new-window';
    readonly owner: 'capture-engine';
}
/** S persists journal before READY. The program is held until H activation
 * commits. I recovers journal binding even if host's record still has null.
 * Raw-created panes are unrecorded + incident, never adopted/rebound later. */
export interface V2BirthReady {
    readonly intent: V2BirthIntent;
    readonly pane: NewarchV2PaneDescriptor;
    readonly binding: Binding;
    readonly byte0: RawPosition;
    readonly journal: EvidenceFile;
    readonly geometryReadback: Geometry;
    readonly paneCountInWindow: 1;
    readonly programHeld: true;
}
export type V2BirthResult = {
    readonly status: 'active';
    readonly owner: V2OwnerRecord;
    readonly receipt: V2Receipt;
} | {
    readonly status: 'rejected';
    readonly operationId: string;
    readonly reason: 'disabled' | 'capacity' | 'identity' | 'geometry' | 'binding' | 'storage' | 'unsupported-topology';
    readonly programReleased: false;
    readonly cleanup: 'not-created' | 'complete' | 'pending';
    readonly incidentId: string | null;
};
/** Compile-time opaque only. H MUST mint after acquiring exclusive OS process
 * lock on canonical root and checking DB generation. Keep in C closure, never
 * serialize/export to auditor/S/O/D/keeper/mux. H rechecks object identity in
 * its private registry + held lock + generation INSIDE every transaction.
 * A structurally forged/copy/deserialized token is not authority. No lease,
 * timeout, flag change or pane stop transfers ownership to legacy. */
declare const v2WriterBrand: unique symbol;
export interface V2WriterCapability {
    readonly [v2WriterBrand]: true;
    readonly owner: 'capture-engine';
    readonly rootId: string;
    readonly engineId: string;
    readonly generation: number;
}
export interface V2WriteFence {
    readonly operationId: string;
    readonly pane: PaneKey;
    readonly expectedGeneration: number;
    readonly expectedRevision: number;
    readonly digest: Digest;
}
export interface V2Receipt {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly kind: 'ssot-durable';
    readonly operationId: string;
    readonly pane: PaneKey;
    readonly digest: Digest;
    readonly commitId: string;
    readonly generation: number;
    readonly revision: number;
    readonly frontier: SegmentRowId | null;
    readonly checkpointId: string | null;
}
/** H first checks live capability/generation. An existing operation with same
 * payload digest returns original receipt before checking expectedRevision;
 * different digest is integrity failure. This ordering handles lost ACK. */
export declare function v2WriteDisposition(f: V2WriteFence, generation: number, revision: number, previous: V2Receipt | null): 'commit' | 'retry' | 'stale' | 'integrity';
export interface V2RuleStamp {
    readonly ruleId: string;
    readonly version: string;
    readonly configVersion: string;
}
export interface V2RuleDefinition {
    readonly stamp: V2RuleStamp;
    readonly priority: number;
    readonly preconditions: readonly ('identity' | 'fixed-geometry' | 'contiguous-bytes' | 'known-vt' | 'ordered-evidence')[];
    readonly maxInputBytes: number;
    readonly maxInputRows: number;
    readonly action: 'accept' | 'defer' | 'gap';
}
/** Lower priority number first; ties by ruleId UTF-8 lexical order. Allowlist
 * selects registered pure functions, never eval/log-supplied code. Persist
 * rule/config stamp per decision; changes apply to NEW raw ranges only. */
export interface V2RuleEvidence {
    readonly raw: RawRange;
    readonly digest: Digest;
    readonly checkpointId: string;
    readonly caseId: string;
    readonly anomalyId: string | null;
}
export type V2RuleResult = {
    readonly kind: 'accept';
    readonly stamp: V2RuleStamp;
    readonly evidence: V2RuleEvidence;
    readonly rows: readonly CommittedStreamRow[];
    readonly checkpoint: V2LiveCheckpoint;
} | {
    readonly kind: 'defer';
    readonly stamp: V2RuleStamp;
    readonly evidence: V2RuleEvidence;
    readonly pendingRows: number;
    readonly pendingBytes: number;
    readonly deadlineMonoMs: number;
} | {
    readonly kind: 'gap';
    readonly stamp: V2RuleStamp;
    readonly evidence: V2RuleEvidence;
    readonly incident: NewarchV2Incident;
};
/** Both VT buffers/cursor/modes and partial UTF8/escape are in state. H stores
 * one current durable projection per pane, plus pinned recovery checkpoints.
 * The live rows are not finalized history. Byte floor is decoder replay floor,
 * not the last raw read/upload position. Size is canonical UTF-8 including VT. */
export interface V2LiveCheckpoint {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly checkpointId: string;
    readonly pane: PaneKey;
    readonly geometry: NewarchV2FixedGeometry;
    readonly through: RawPosition;
    readonly replayFloor: RawPosition;
    readonly revision: number;
    readonly frontier: SegmentRowId | null;
    readonly rule: V2RuleStamp;
    readonly state: VtState;
    readonly stateDigest: Digest;
    readonly pending: {
        readonly rows: readonly RowContent[];
        readonly bytes: number;
        readonly deadlineMonoMs: number | null;
    };
}
export interface V2AuditWatermark {
    readonly pane: PaneKey;
    readonly through: RawPosition;
    readonly revision: number;
    readonly geometry: NewarchV2FixedGeometry;
    readonly checkpointId: string;
}
/** Transport must prove snapshot ordering, not just drain pipe. Non-quiescent
 * captures without independent same-source evidence are inconclusive. */
export interface V2AuditEvidence {
    readonly before: V2AuditWatermark;
    readonly after: V2AuditWatermark;
    readonly snapshot: V2AuditWatermark;
    readonly ordering: {
        readonly kind: 'certified-source-fence';
        readonly certificateId: string;
        readonly proof: EvidenceFile;
    } | {
        readonly kind: 'unproven';
    };
    readonly expectedDigest: Digest;
    readonly actualDigest: Digest;
    readonly captureBytes: number;
    readonly elapsedMs: number;
}
export type V2AuditResult = {
    readonly kind: 'match';
    readonly evidence: V2AuditEvidence;
    readonly rule: V2RuleStamp;
} | {
    readonly kind: 'repair-pending';
    readonly evidence: V2AuditEvidence;
    readonly rule: V2RuleStamp;
    readonly expectedRevision: number;
    readonly checkpoint: V2LiveCheckpoint;
    readonly incident: NewarchV2Incident;
} | {
    readonly kind: 'annotate';
    readonly evidence: V2AuditEvidence;
    readonly rule: V2RuleStamp;
    readonly incident: NewarchV2Incident;
} | {
    readonly kind: 'inconclusive';
    readonly reason: 'disabled' | 'timeout' | 'bytes' | 'pane-dead' | 'identity' | 'racing' | 'stale';
    readonly retry: boolean;
};
/** Pure admission predicate; C performs actual normalization/evaluation. Even a
 * true result must be rechecked in H under expectedRevision before repair. */
export declare function v2AuditComparable(e: V2AuditEvidence, current: V2AuditWatermark, c: V2AuditConfig): boolean;
export interface V2Batch {
    readonly rows: readonly CommittedStreamRow[];
    readonly decisions: readonly V2RuleResult[];
    readonly incidents: readonly NewarchV2Incident[];
    readonly checkpoint: V2LiveCheckpoint;
    readonly input: V2BatchInput;
}
export interface V2RemoteLocator {
    readonly pane: PaneKey;
    readonly segmentId: string;
    readonly sealed: LogicalSealR2;
    readonly verified: VerifiedBundle;
    readonly inventory: ArchiveInventoryR2;
    /** Successful bounded PUBLIC reader readback, not upload success. */
    readonly readerProof: {
        readonly digest: Digest;
        readonly verifiedAtWallMs: number;
        readonly first: SegmentRowId | null;
        readonly last: SegmentRowId | null;
    };
}
/** All persistent mutations, including owner/birth/staging/stop/locator/pins,
 * traverse C's one queue. O and S submit requests/evidence, never get H/cap.
 * Pin/release from D are also queued commands, not a second DB writer. */
export type V2WriteCommand = {
    readonly kind: 'activate';
    readonly ready: V2BirthReady;
    readonly checkpoint: V2LiveCheckpoint;
} | {
    readonly kind: 'batch';
    readonly batch: V2Batch;
} | {
    readonly kind: 'stage';
    readonly transactionId: string;
    readonly ordinal: number;
    readonly rows: readonly CommittedStreamRow[];
} | {
    readonly kind: 'incident';
    readonly incident: NewarchV2Incident;
} | {
    readonly kind: 'audit';
    readonly result: V2AuditResult;
} | {
    readonly kind: 'checkpoint';
    readonly checkpoint: V2LiveCheckpoint;
} | {
    readonly kind: 'stop';
    readonly incident: NewarchV2Incident;
} | {
    readonly kind: 'close';
} | {
    readonly kind: 'seal';
    readonly segmentId: string;
} | {
    readonly kind: 'materialize-export';
    readonly sealCommitId: string;
} | {
    readonly kind: 'unrecorded-birth';
    readonly pane: NewarchV2PaneDescriptor;
    readonly incident: NewarchV2Incident;
} | {
    readonly kind: 'locator';
    readonly locator: V2RemoteLocator;
} | {
    readonly kind: 'reclaim';
    readonly locatorCommitId: string;
    readonly segmentId: string;
} | {
    readonly kind: 'pin';
    readonly pinId: string;
    readonly segmentId: string;
} | {
    readonly kind: 'release-pin';
    readonly pinId: string;
};
export interface V2WriteRequest {
    readonly fence: V2WriteFence;
    readonly command: V2WriteCommand;
}
/** Digest covers semantic payload: pane + operationId + command. Outer
 * generation/revision are concurrency preconditions, excluded so a restarted
 * engine can retry with its current generation and get the original receipt.
 * Audit expectedRevision INSIDE its command remains hashed. Capability never
 * enters hashes/serialization. Stage rows never become visible by staging. */
export declare function v2WriteDigest(request: {
    readonly fence: Omit<V2WriteFence, 'digest'>;
    readonly command: V2WriteCommand;
}, encode?: (value: unknown) => string): Digest;
export interface V2HistoryWriter {
    commit(capability: V2WriterCapability, request: V2WriteRequest): Promise<Result<V2Receipt>>;
    /** H closes only after queued transactions settle, then releases OS lock. */
    close(capability: V2WriterCapability): Promise<Result<null>>;
}
export interface V2CaptureWriteFacade {
    submit(request: V2WriteRequest): Promise<Result<V2Receipt>>;
    /** Stop intake, drain pump/audit/stop, persist incident and retire own pipe.
     * Full shutdown closes H only after ALL pane queues settle. */
    close(): Promise<Result<null>>;
}
export interface V2HistoryPage {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly pane: PaneKey;
    readonly revision: number;
    readonly entries: readonly ({
        readonly kind: 'row';
        readonly row: CommittedStreamRow;
    } | {
        readonly kind: 'incident';
        readonly incident: NewarchV2Incident;
    })[];
    readonly payloadBytes: number;
    readonly states: readonly NewarchV2ReadState[];
    readonly before: NewarchV2Continuation;
    readonly after: NewarchV2Continuation;
}
export interface V2HistoryReader {
    owner(pane: PaneKey): Result<V2OwnerRecord | null>;
    receipt(pane: PaneKey, operationId: string): Result<V2Receipt | null>;
    checkpoint(pane: PaneKey): Result<V2LiveCheckpoint | null>;
    page(request: NewarchV2HistoryRequest): Promise<Result<V2HistoryPage>>;
}
export interface V2TrimAuthorization {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly checkpoint: V2LiveCheckpoint;
    readonly receipt: V2Receipt;
    readonly consumerAck: SpoolAck;
    readonly trimThrough: RawPosition;
}
/** Structural guard only: S resolves receipt/checkpoint from H authority and
 * validates durable raw digest/contiguity/pins before applying. No boolean from
 * host or O substitutes for receipt readback. No ACK on failed H commit. */
export declare function v2TrimWithinCheckpoint(a: V2TrimAuthorization): boolean;
/** Reservation precedes tmux creation, so no pane id exists yet. It is a
 * root-queue operation, distinct from pane writes. Session reservation is
 * durable before S creates anything; future panes inherit this owner. */
export interface V2SessionReservation {
    readonly intent: V2BirthIntent;
    readonly expectedGeneration: number;
    readonly digest: Digest;
}
export interface V2SessionReservationReceipt {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly session: NewarchV2SessionKey;
    readonly operationId: string;
    readonly commitId: string;
    readonly digest: Digest;
    readonly generation: number;
    readonly owner: 'capture-engine';
}
export interface V2HistoryWriter {
    reserveBirth(capability: V2WriterCapability, request: V2SessionReservation): Promise<Result<V2SessionReservationReceipt>>;
}
export interface V2CaptureWriteFacade {
    reserveBirth(request: V2SessionReservation): Promise<Result<V2SessionReservationReceipt>>;
}
/** Only capture-engine composition calls open; host receives facade+reader,
 * not this factory or capability. H canonicalizes root, holds an OS lock for
 * its process lifetime and atomically increments generation on exclusive open.
 * An unreadable owner/schema store fails closed before ANY writer starts. */
export interface V2HistoryFactory {
    openForCapture(request: {
        readonly rootId: string;
        readonly engineId: string;
        readonly config: V2Config;
        /** HS2: omitted = v2LegacyStorageProfile(config.storage). Its storage must
         * equal config.storage; the root keeps the digest it was first opened with. */
        readonly storageProfile?: V2StorageProfile;
    }): Promise<Result<{
        readonly capability: V2WriterCapability;
        readonly writer: V2HistoryWriter;
        readonly reader: V2HistoryReader;
    }>>;
}
export interface V2GeometryObservation {
    readonly pane: PaneKey;
    readonly windowId: string;
    readonly window: Geometry;
    readonly terminal: Geometry;
    readonly panesInWindow: number;
}
export declare function v2GeometryMatches(d: NewarchV2PaneDescriptor, observed: V2GeometryObservation): boolean;
/** This proves only an observation, not continuity between observations.
 * I must gate before each commit and at resume even with audit disabled.
 * No continuity proof across downtime => unverified-restart + STOP before
 * replay, including 100->120->100. Epoch change likewise stops, no rebind. */
export type V2ResumeProof = {
    readonly kind: 'continuous';
    readonly pane: PaneKey;
    readonly from: RawPosition;
    readonly through: RawPosition;
    readonly geometry: NewarchV2FixedGeometry;
    readonly sourceEvidence: EvidenceFile;
} | {
    readonly kind: 'unverified';
    readonly reason: 'geometry' | 'raw' | 'collector-epoch' | 'identity';
};
export declare function validateV2Checkpoint(c: V2LiveCheckpoint, encode?: (value: unknown) => string): void;
export declare function validateV2Incident(i: NewarchV2Incident): void;
export declare function validateV2ReadRequest(r: NewarchV2HistoryRequest): void;
/** S emergency journal is a transport for C, NOT a parallel SSOT writer.
 * Use the SAME incident id/digest on materialization; pending is visible to D.
 * Protocol faults do not consume reserve. If reserve write fails, stop intake,
 * return unavailable and mark durability gate FAILED (never a durable receipt).
 * Rearm only after engine confirms materialization/resolution + physical space. */
export interface V2EmergencyIncident {
    readonly incident: NewarchV2Incident;
    readonly digest: Digest;
    readonly cause: 'ENOSPC' | 'EDQUOT' | 'SQLITE_FULL';
}
export interface V2SourceTransport {
    prepareBirth(intent: V2BirthIntent, reservation: V2SessionReservationReceipt): Promise<Result<V2BirthReady>>;
    releaseProgram(ready: V2BirthReady, activation: V2Receipt): Promise<Result<null>>;
    retireOwnPipe(binding: Binding, operationId: string): Promise<Result<null>>;
    acknowledgeAndTrim(authorization: V2TrimAuthorization): Promise<Result<TrimReceiptR2>>;
    journalEmergency(request: V2EmergencyIncident): Promise<Result<{
        readonly journal: EvidenceFile;
        readonly incidentId: string;
    }>>;
}
/** Audit scheduling policy (I): enabled=false creates NO capture/timer. Interval
 * 0 disables periodic work only; empty triggers disables event work. Stable
 * pane-hash jitter in +/- jitterFraction; minGap applies to retries too. One
 * queued job/pane (max21), coalesce trigger storms, no unbounded backlog. One
 * retry maximum; reset retry budget on a NEW eligible event, not on timeout.
 * capture-pane -p visible screen ONLY (no -S -, no -J), shared C normalizer.
 * Keep one latest watermark per pane; diagnostics rotate, incidents persist.
 * Geometry/storage guards run independently of audit settings.
 *
 * Rule policy (C): defer <=1000 ms and <=256 rows/1MiB; expiry emits gap or
 * stop, never silently drops bytes. Pending repair uses expectedRevision and
 * may change live/pending ONLY. Finalized rows are immutable: append annotation
 * covering affected range instead. For conflicting evidence choose gap, not
 * content-only deduplication. Unknown loss stays null, no numerical fault cap.
 *
 * Lifecycle (I/H): reserved->active->stopped->closed or reserved->stopped;
 * unrecorded->closed. No transition back to active. Stop/close do not delete
 * owner. Incidents dedupe by (PaneKey, incidentId), conflict digest rejected.
 * Reclaim (O/H): seal, upload, readback hash, queued locator commit, public
 * reader proof, then queued reclaim with zero pins + generation recheck in H.
 * Local deletion retries idempotently; never delete final verified copy.
 *
 * Q gate: online counters only, census PID+startTime, missing sample invalid;
 * sampler/oracle outside product tree reported separately; no slope subtraction.
 * 21 active panes and both fixed rates, sample startup/audit/restore transients,
 * max <=1536MiB, slope10..60 <=10MiB/hour, mid/late means <=early+10MiB.
 * This 60min gate does NOT replace the existing 180min plateau gate. Native
 * growth +22.7MiB/hour in premeasure is unresolved by a contract-only change.
 */
export interface V2RuleInput {
    readonly pane: NewarchV2PaneDescriptor;
    readonly checkpoint: V2LiveCheckpoint;
    readonly raw: RawRange;
    readonly bytes: readonly number[];
    readonly observedAtMonoMs: number;
    readonly pendingSinceMonoMs: number | null;
}
export type V2RuleEvaluator = (input: V2RuleInput) => V2RuleResult;
export interface V2SourceTransport {
    /** Raw durable reads are bounded at ingress; invalid sequence/digest/epoch
     * is a gap-and-stop request to C, never recovery capture. */
    readRaw(binding: Binding, after: RawPosition, maxRecords: number, maxBytes: number): Promise<Result<SpoolReadR2>>;
}
export interface V2CancelBirth {
    readonly session: NewarchV2SessionKey;
    readonly birthOperationId: string;
    readonly operationId: string;
    readonly expectedGeneration: number;
    readonly digest: Digest;
    readonly reason: 'disabled' | 'capacity' | 'identity' | 'geometry' | 'binding' | 'storage';
}
export interface V2HistoryWriter {
    /** Retain owner tombstone; this cancels pending birth, never returns legacy.
     * If pane was created, persist incident/retire via its pane queue as well. */
    cancelBirth(capability: V2WriterCapability, request: V2CancelBirth): Promise<Result<V2SessionReservationReceipt>>;
}
export interface V2CaptureWriteFacade {
    cancelBirth(request: V2CancelBirth): Promise<Result<V2SessionReservationReceipt>>;
}
/** H lists owner records from disk, <=256 entries/2MiB; never materialize all
 * historical panes/incidents in RAM. Display name lookup is advisory and must
 * resolve to a stable session before this port; I rechecks after every await. */
export interface V2HistoryReader {
    panes(session: NewarchV2SessionKey, cursor: string | null): Result<{
        readonly panes: readonly NewarchV2PaneDescriptor[];
        readonly next: string | null;
    }>;
}
export interface V2SessionOwnerRecord {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly session: NewarchV2SessionKey;
    readonly owner: 'capture-engine';
    readonly birthOperationId: string;
    readonly state: 'reserved' | 'active' | 'closed';
    readonly generation: number;
}
export interface V2HistoryReader {
    /** null means authoritative absence, error means UNKNOWN, never legacy. */
    sessionOwner(session: NewarchV2SessionKey): Result<V2SessionOwnerRecord | null>;
    sealed(pane: PaneKey, sealCommitId: string): Result<LogicalSealR2 | null>;
    export(pane: PaneKey, operationId: string): Result<SealedExport | null>;
    locator(pane: PaneKey, locatorCommitId: string): Result<V2RemoteLocator | null>;
}
export interface V2SourceTransport {
    rearmReserve(request: {
        readonly incidentId: string;
        readonly resolved: V2Receipt;
    }): Promise<Result<{
        readonly physicalFreeBytes: number;
        readonly reserveAllocatedBytes: number;
    }>>;
}
/** H root generation increments only on exclusive engine open. Each successful
 * NEW pane transaction advances its revision once; retry preserves receipt.
 * Reservation/cancel use v2Digest('birth-reservation'|'birth-cancel', request
 * without digest/expectedGeneration). Incident ID uses this stable function BEFORE any write;
 * persist operationId with the cause/barrier, reuse after ACK loss/restart.
 * Wall/mono clocks and diagnostics never influence incident identity. */
export declare function v2IncidentId(pane: PaneKey, operationId: string): string;
/** Reader paging: entries stay in ascending timeline order in either direction.
 * payloadBytes is canonical UTF-8 entries size; both entry/byte limits apply.
 * Before/after null cursor starts at tail/head respectively. Oversized single
 * entry returns an explicit bounded-read error, never an empty success page.
 * H authenticates opaque cursor against store + pane + retained timeline, and
 * rejects future revisions. Segment movement alone never expires a cursor.
 * Revision is a grant fence; new entries do not retroactively enter that page.
 * For raw-created panes, unrecorded-birth inserts owner+incident atomically,
 * state=unrecorded and no collector binding. It NEVER enables later adoption.
 * The reservation tombstone excludes legacy even when creation was cancelled.
 *
 * Audit certificates reference bounded, redacted source ordering evidence;
 * I/C must validate that evidence, not merely accept this structural guard.
 * A quiet-looking pair of captures or pipe drain is not a source certificate.
 */
/** C startup rejects allowlisted IDs/versions absent from its compiled registry
 * (no dynamic code loading). Default priority 10 ordered-scroll: accept only
 * proven ordered retirement; 20 bounded-tail: defer uncertain live/pending;
 * 30 explicit-gap: close unresolved range when tail/deadline exhausted. No
 * matching rule also means explicit gap, never accept/drop. Adding a rule
 * requires a deterministic redacted caseId/anomalyId fixture first.
 * Remaining unchanged RAM/latency/page/read concurrency budgets are exactly
 * STREAM_BUDGET; NEWARCH_V2_LIMITS overrides only explicitly named v2 fields.
 */
export declare function v2DeferWithinBudget(result: Extract<V2RuleResult, {
    readonly kind: 'defer';
}>, firstDeferredAtMonoMs: number, nowMonoMs: number): boolean;
export interface V2HistoryReader {
    /** One bounded latest result per pane. Inconclusive updates this status only,
     * never rows/checkpoint or auditedRevision. disabled never starts a timer. */
    lastAudit(pane: PaneKey): Result<V2AuditResult | null>;
}
import type { NewarchV2SourceEpoch } from '../core/index.js';
export type { NewarchV2SourceEpoch } from '../core/index.js';
declare const v2WriterGenerationBrand: unique symbol;
declare const v2ContinuityGenerationBrand: unique symbol;
export type V2WriterGeneration = number & {
    readonly [v2WriterGenerationBrand]: 'writer';
};
export type V2ContinuityGeneration = number & {
    readonly [v2ContinuityGenerationBrand]: 'continuity';
};
/** Each constructor refuses the OTHER brand (review K-r1 B1): a bare number
 * (e.g. V2Receipt.generation) names its role here, a continuity value cannot be
 * re-minted as a writer value and vice versa. A cast through `unknown` is
 * invisible to the type system; runtime role checks stay with the callers. */
export declare function v2WriterGeneration(n: number & {
    readonly [v2ContinuityGenerationBrand]?: never;
}): V2WriterGeneration;
export declare function v2ContinuityGeneration(n: number & {
    readonly [v2WriterGenerationBrand]?: never;
}): V2ContinuityGeneration;
export declare function v2SourceEpochOf(epoch: PipeEpoch): NewarchV2SourceEpoch;
/** Bounded decode prefix (B1). Exactly the existing per-pane budgets; a burst
 * larger than one prefix is several prefixes, never a larger budget or a gap. */
export declare const NEWARCH_V2_PREFIX_LIMITS: Readonly<{
    readonly maxRawBytes: number;
    readonly maxRows: 256;
    readonly maxSerializedBytes: number;
    readonly checkpointBytes: number;
}>;
export type V2PrefixStop = 'complete' | 'raw-bytes' | 'rows' | 'serialized-bytes';
/** offered = raw the decoder was handed, starting at base checkpoint.through.
 * consumed = the decoded prefix; checkpoint.through is consumed.end and carries
 * partial UTF-8/escape. suffix = [consumed.end, offered.end), NOT certified and
 * NOT acknowledged; it stays in the spool and is re-offered from checkpoint.
 * serializedBytes = canonical UTF-8 of rows (cellOrigins included, not trimmed). */
export interface V2DecodePrefix {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly pane: PaneKey;
    readonly offered: RawRange;
    readonly consumed: RawRange;
    readonly rows: readonly CommittedStreamRow[];
    readonly serializedBytes: number;
    readonly checkpoint: V2LiveCheckpoint;
    readonly stop: V2PrefixStop;
    readonly suffix: RawRange | null;
}
export declare function v2RowsSerializedBytes(rows: readonly CommittedStreamRow[], encode?: (value: unknown) => string): number;
/** Zero progress on non-empty input is not a prefix: C must emit a gap. */
export declare function v2DecodePrefixValid(p: V2DecodePrefix, base: V2LiveCheckpoint): boolean;
/** Collector-issued (S1): S read back this durable raw subrange, its record
 * chain and digests. certified is the committed prefix range (certifyPrefix is
 * asked for prefix.consumed), so certified.end === checkpoint.through.
 * lastRecordEnd is the byte end of the last spool record the range touches and
 * may exceed certified.end when the prefix ends mid-record. The host never
 * mints this; digest = v2SourcePrefixReceiptDigest(rest). The digest is public,
 * so it proves integrity, not origin: S compares with what it issued
 * (v2PrefixAckMatchesIssued). */
export interface V2SourcePrefixReceipt {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly kind: 'source-prefix';
    readonly receiptId: string;
    readonly sourceEpoch: NewarchV2SourceEpoch;
    readonly certified: RawRange;
    readonly firstSequence: number;
    readonly lastSequence: number;
    readonly lastRecordDigest: Digest;
    readonly lastRecordEnd: number;
    readonly digest: Digest;
}
export declare function v2SourcePrefixReceiptDigest(r: Omit<V2SourcePrefixReceipt, 'digest'>): Digest;
/** Batch evidence is independent of consumer ACK. Only S issues either arm.
 * H reads the exact issued object synchronously INSIDE its write transaction.
 * No public note/set API: the S-owned bounded cache is populated only by a
 * successful collector RPC; retain pending inputs until commit/retry settles.
 * Missing/evicted/error is refusal, never permission to re-hash host input. */
export type V2BatchInput = SpoolAck | V2SourcePrefixReceipt;
export interface V2IssuedInputAuthority {
    inputReceipt(input: V2BatchInput): Result<V2BatchInput | null>;
}
/** Pure exact-input check, not authentication. `issued` must be read directly
 * from S's authority, never supplied by the host or inferred from a digest.
 * H still checks capability, revision, row/frontier/budgets and atomicity.
 * The record branch retains the old exact-ACK/checkpoint semantics. */
export declare function v2BatchInputMatchesIssued(input: V2BatchInput, issued: V2BatchInput | null, previous: V2LiveCheckpoint, checkpoint: V2LiveCheckpoint): boolean;
/** V2 indexed replay includes the WHOLE containing record in every budget.
 * These caps fit the existing 256 KiB collector RPC frame (4 KiB envelope
 * reserve). No first-record exception. BS must measure before materializing,
 * seek with the (id,start) index, and verify length/digest/chain/pane/epoch
 * including bytes before requested. Only then may the adapter slice at
 * requested.byteOffset - record.range.start; the slice is NOT a SpoolRecord.
 * The complete record ACK is collector-issued, never reconstructed by host. */
export declare const V2_CONTAINING_REPLAY_LIMITS: Readonly<{
    readonly recordBytes: number;
    readonly maxRecords: 16;
    readonly maxRawBytes: number;
    readonly maxSerializedBytes: number;
}>;
export interface V2ContainingReplayBudget {
    readonly maxRecords: number;
    readonly maxRawBytes: number;
    readonly maxSerializedBytes: number;
}
export interface V2ContainingRecord {
    readonly record: SpoolRecord;
    readonly ack: SpoolAck;
}
export type V2ContainingReplay = {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly kind: 'records';
    readonly requested: RawPosition;
    readonly records: readonly V2ContainingRecord[];
    readonly next: RawPosition;
    readonly atDurableHead: boolean;
} | {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly kind: 'below-floor';
    readonly requested: RawPosition;
    readonly retained: TrimReceiptR2;
} | {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly kind: 'budget-required';
    readonly requested: RawPosition;
    /** Minimum for one complete record, within the hard caps. Above-hard-cap
     * data is an integrity error, not an invitation to increase limits. */
    readonly minimum: V2ContainingReplayBudget;
};
export interface V2ContainingReplayPort {
    replayContaining(binding: Binding, requested: RawPosition, budget: V2ContainingReplayBudget): Promise<Result<V2ContainingReplay>>;
}
export declare function v2ContainingReplayBudgetValid(b: V2ContainingReplayBudget): boolean;
/** Client-side verification of a bounded records reply before slicing. Does
 * not authenticate ACK origin: BS must receive this reply from its collector.
 * Service must enforce the same bounds BEFORE allocation/query materialization.
 * Typed below-floor/budget-required are refusals, not successful EOF. */
export declare function v2ContainingReplayRecordsValid(reply: V2ContainingReplay, requested: RawPosition, budget: V2ContainingReplayBudget): boolean;
/** What the host sends back after H committed a prefix. through is EXACTLY the
 * committed checkpoint.through: never the record end, never beyond. A prefix
 * that stops mid-record is recordComplete=false and S keeps the record tail. */
export interface V2PrefixAck {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly kind: 'prefix-ack';
    readonly pane: PaneKey;
    readonly through: RawPosition;
    readonly recordComplete: boolean;
    readonly source: V2SourcePrefixReceipt;
    readonly receipt: V2Receipt;
    readonly writerGeneration: V2WriterGeneration;
    readonly continuityGeneration: V2ContinuityGeneration;
    readonly sourceEpoch: NewarchV2SourceEpoch;
}
export declare function v2PrefixAckValid(ack: V2PrefixAck, checkpoint: V2LiveCheckpoint, expected: {
    readonly writerGeneration: V2WriterGeneration;
    readonly continuityGeneration: V2ContinuityGeneration;
}): boolean;
/** Structural check PLUS identity with the receipt S itself issued for this
 * prefix (review K-r1 B2). v2PrefixAckValid alone accepts a receipt the host
 * re-signed (e.g. lastRecordEnd moved onto the commit point to claim
 * recordComplete); only the byte-for-byte comparison with the issued receipt
 * (all fields, digest included) refuses it. issued must itself be well-signed. */
export declare function v2PrefixAckMatchesIssued(ack: V2PrefixAck, issued: V2SourcePrefixReceipt, checkpoint: V2LiveCheckpoint, expected: {
    readonly writerGeneration: V2WriterGeneration;
    readonly continuityGeneration: V2ContinuityGeneration;
}): boolean;
/** S1 implements; the host may only forward collector receipts. */
export interface V2PrefixSourcePort {
    /** range = the committed prefix (V2DecodePrefix.consumed); the receipt
     * certifies exactly that range. S keeps what it issued, keyed by receiptId. */
    certifyPrefix(binding: Binding, range: RawRange): Promise<Result<V2SourcePrefixReceipt>>;
    /** S MUST look up the receipt it issued (ack.source.receiptId) and accept only
     * if v2PrefixAckMatchesIssued(ack, issued, ...) — v2PrefixAckValid alone is not
     * enough — AND read receipt/checkpoint back from H before advancing its
     * consumer ACK; no ACK when the H commit failed or the receipt is unknown. */
    acknowledgePrefix(ack: V2PrefixAck): Promise<Result<{
        readonly through: RawPosition;
        readonly recordComplete: boolean;
    }>>;
}
/** Continuity witness (S2/J). Only evidence kind 'collector-witness' can prove
 * continuity; the other variants exist so callers can carry what they have and
 * get an explicit refusal instead of an accidental pass. */
export declare const V2_CONTINUITY_REQUIRED_EVENTS: readonly ["resize", "layout", "split", "window", "pipe", "server-exit"];
export type V2TopologyEventKind = typeof V2_CONTINUITY_REQUIRED_EVENTS[number];
/** covers lists event kinds whose hook/notification coverage was PROVEN on the
 * installed tmux (coverageProof), not hooks that merely have a fitting name.
 * fromSeq..throughSeq is the validity watermark that survives journal rotation;
 * overflow or lostEvents>0 invalidates the witness. topologyEvents counts every
 * resize/layout/split/window event inside the interval, INCLUDING ones that
 * return to the same size (78->80->78 is not exact). */
export interface V2EventWatch {
    readonly kind: 'tmux-event-journal';
    readonly journal: EvidenceFile;
    readonly coverageProof: EvidenceFile;
    readonly covers: readonly V2TopologyEventKind[];
    readonly fromSeq: number;
    readonly throughSeq: number;
    readonly watermarkDigest: Digest;
    readonly overflow: boolean;
    readonly lostEvents: number;
    readonly topologyEvents: number;
}
/** Durable witness owned by the collector/service that survives the host. The
 * collector unit/cgroup must differ from the host's. raw = contiguous durable
 * interval (records firstSequence..lastSequence, no hole) observed while the
 * host was down. digest = v2ContinuityWitnessDigest(rest). */
export interface V2ContinuityWitness {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly witnessId: string;
    readonly pane: PaneKey;
    readonly windowId: string;
    readonly server: {
        readonly serverIdentity: string;
        readonly process: ProcessIdentity;
    };
    readonly collector: {
        readonly incarnation: string;
        readonly process: ProcessIdentity;
        readonly unit: string;
    };
    readonly sourceEpoch: NewarchV2SourceEpoch;
    readonly raw: RawRange;
    readonly records: {
        readonly firstSequence: number;
        readonly lastSequence: number;
        readonly chainDigest: Digest;
    };
    readonly continuityGeneration: V2ContinuityGeneration;
    readonly geometry: NewarchV2FixedGeometry;
    readonly watch: V2EventWatch;
    readonly digest: Digest;
}
export declare function v2ContinuityWitnessDigest(w: Omit<V2ContinuityWitness, 'digest'>): Digest;
export type V2ContinuityEvidence = {
    readonly kind: 'collector-witness';
    readonly witness: V2ContinuityWitness;
}
/** Same-size captures at two times. NOT continuity evidence. */
 | {
    readonly kind: 'snapshot-pair';
    readonly before: V2GeometryObservation;
    readonly after: V2GeometryObservation;
}
/** #{pane_pipe}=1 cannot prove the pipe was never replaced. NOT evidence. */
 | {
    readonly kind: 'pipe-flag';
    readonly panePipe: 1;
}
/** Liveness at a point in time. NOT evidence. */
 | {
    readonly kind: 'heartbeat';
    readonly lastSeenWallMs: number;
};
export type V2ResumeRefusal = 'not-a-witness' | 'witness-digest' | 'identity' | 'collector-epoch' | 'collector-with-host' | 'raw' | 'geometry' | 'event-coverage' | 'event-overflow' | 'topology-changed';
export type V2ResumeDecision = Extract<V2ResumeProof, {
    readonly kind: 'continuous';
}> | {
    readonly kind: 'unverified';
    readonly reason: V2ResumeRefusal;
};
/** Everything J observes now, after host restart, from S and tmux (not from
 * the witness itself). durableRawThrough = S durable head for the epoch. */
export interface V2ResumeContext {
    readonly checkpoint: V2LiveCheckpoint;
    readonly descriptor: NewarchV2PaneDescriptor;
    readonly server: {
        readonly serverIdentity: string;
        readonly process: ProcessIdentity;
    };
    readonly collector: {
        readonly incarnation: string;
        readonly process: ProcessIdentity;
    };
    readonly sourceEpoch: NewarchV2SourceEpoch;
    readonly continuityGeneration: V2ContinuityGeneration;
    readonly hostUnit: string;
    readonly durableRawThrough: RawPosition;
}
/** Pure decision. continuous => J may replay from checkpoint without rebind;
 * anything else => unverified-restart + labelled stop (fail-safe kept). */
export declare function v2ResumeDecision(e: V2ContinuityEvidence, ctx: V2ResumeContext): V2ResumeDecision;
/** S2 implements on the collector side; the host only reads. */
export interface V2ContinuityWitnessPort {
    witness(binding: Binding, from: RawPosition): Promise<Result<V2ContinuityEvidence>>;
}
/** Pending storage incident (E). S journals it before H can write; D shows it
 * as storage-unavailable with pendingIncidentId; C later materializes the SAME
 * incident (same id, same digest) exactly once. */
export declare function v2EmergencyIncidentDigest(incident: NewarchV2Incident): Digest;
export interface V2PendingStorageIncident {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly kind: 'pending-storage';
    readonly pane: PaneKey;
    readonly incidentId: string;
    readonly incidentDigest: Digest;
    readonly cause: V2EmergencyIncident['cause'];
    readonly journal: EvidenceFile;
}
export declare function v2PendingFromEmergency(e: V2EmergencyIncident, journal: EvidenceFile): V2PendingStorageIncident;
export declare function v2PendingReadState(p: V2PendingStorageIncident, retryAfterMs: number): NewarchV2ReadState;
export declare function v2MaterializesPending(p: V2PendingStorageIncident, incident: NewarchV2Incident): boolean;
/** Reader authority (H). Answered from H's CURRENT transaction; receipt is the
 * durable receipt that materialized/resolved this incident (null while pending). */
export interface V2IncidentResolution {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly pane: PaneKey;
    readonly incidentId: string;
    readonly state: 'pending' | 'resolved';
    readonly receipt: V2Receipt | null;
    readonly writerGeneration: V2WriterGeneration;
}
/** True only for: resolved, same pane + incident id, the same receipt, and the
 * current writer generation. Pending, other id, stale generation => false. */
export declare function v2IncidentResolvedBy(r: V2IncidentResolution | null, incidentId: string, receipt: V2Receipt, current: V2WriterGeneration): boolean;
/** Read-only observation from the CURRENT H engine, not a new durable
 * receipt, ACK, trim authorization or resume proof. The original resolution
 * and receipt remain unchanged even when authorizedGeneration has advanced. */
export interface V2ReserveRearmObservation {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly purpose: 'reserve-rearm';
    readonly pane: PaneKey;
    readonly incidentId: string;
    readonly incidentDigest: Digest;
    readonly resolvedReceipt: V2Receipt;
    readonly authorizedGeneration: V2WriterGeneration;
}
/** Structural check only. Transport must read reserveRearm AND the exact
 * receipt directly from live H on EVERY attempt under the pane queue; no await
 * may release the writer lifetime between generation check and RPC dispatch.
 * Null/error/closed authority refuses. A cached observation or true callback
 * cannot substitute for those reads. Old ACK/trim guards remain unchanged. */
export declare function v2ReserveRearmAllowed(observation: V2ReserveRearmObservation | null, pane: PaneKey, incidentId: string, incidentDigest: Digest, receipt: V2Receipt, current: V2WriterGeneration): boolean;
/** Raw pins are readers of raw spool bytes (replay, decoder checkpoint, audit,
 * export). Row/segment pins are counted separately and never block raw trim. */
export type V2RawPinHolder = 'replay' | 'decoder-checkpoint' | 'audit' | 'export';
export interface V2RawPinCensus {
    readonly schema: typeof NEWARCH_V2_VERSION;
    readonly pane: PaneKey;
    readonly epoch: PipeEpoch;
    readonly revision: number;
    readonly writerGeneration: V2WriterGeneration;
    readonly rawPins: readonly {
        readonly pinId: string;
        readonly holder: V2RawPinHolder;
        readonly from: RawPosition;
    }[];
    readonly rowPins: number;
}
/** Structural trim guard + census taken at the checkpoint revision: no raw pin
 * may start below trimThrough. Replaces the trimUnpinned=true constant. */
export declare function v2RawTrimUnpinned(a: V2TrimAuthorization, census: V2RawPinCensus, current: V2WriterGeneration): boolean;
/** H implements (read-only, no write capability). Maps 1:1 onto S's existing
 * V2SourceOptions.trimUnpinned / incidentResolved callbacks. */
export interface V2HistoryAuthority {
    writerGeneration(): Result<V2WriterGeneration>;
    /** Read transaction checks live internal cap/expectedGeneration, stored
     * resolved incident id/digest/revision and exact receipt readback/checksum.
     * stored writerGeneration must equal the ORIGINAL receipt generation.
     * No write/refresh/no-op commit. Missing resolution returns null; errors
     * refuse. Consumers must never turn null/error into an armed reserve. */
    reserveRearm(pane: PaneKey, incidentId: string, expectedGeneration: V2WriterGeneration): Result<V2ReserveRearmObservation | null>;
    incidentResolution(pane: PaneKey, incidentId: string): Result<V2IncidentResolution | null>;
    rawPins(pane: PaneKey, epoch: PipeEpoch): Result<V2RawPinCensus>;
}
/** Cursor scope (D1/D3): a cursor is usable only for the pane it was minted for. */
export declare function v2CursorForPane(pane: PaneKey, cursor: NewarchV2HistoryCursor | null): NewarchV2HistoryCursor | null;
