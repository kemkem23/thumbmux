import { createHash } from 'node:crypto';
/** Stream-first v1. Normative semantics: docs/tasks/newarch-stream/DESIGN.md.
 * No I/O here. Implementations must validate untrusted input at their boundary.
 * All counters are nonnegative safe integers; line ranges are [start, end).
 * Readonly is an ownership contract: implementations must copy/freeze buffers.
 */
export const STREAM_CONTRACT_VERSION = 1 as const;
const MiB = 1024 * 1024;
export const STREAM_BUDGET = Object.freeze({
  processTreePssHardBytes: 1536 * MiB, memoryDebtTargetBytes: 512 * MiB,
  plateauMinMs: 180 * 60_000, plateauMaxDeltaBytes: 10 * MiB,
  panes: 21, maxColumns: 240, maxRows: 80,
  vtBytesPerPane: 2 * MiB, tailRowsPerPane: 256, tailBytesPerPane: MiB,
  rawBytesPerPane: 256 * 1024, metadataBytesPerPane: MiB / 4,
  pendingBytes: 16 * MiB, scratchBytes: 32 * MiB, diskCacheBytes: 12 * MiB,
  pagePoolBytes: 16 * MiB, pageBytesPerViewer: 2 * MiB, wsPendingBytes: 8 * MiB,
  unattributedReserveBytes: 96 * MiB,
  blockRows: 256, blockPayloadBytes: 256 * 1024,
  decodeRows: 256, decodeBytes: MiB, pageBytes: 2 * MiB,
  defaultPageRows: 500, maxPageRows: 2000, repairHorizonRows: 5012,
  activeReadsGlobal: 2, activeReadsPerPane: 1, queuedReads: 21,
  readDeadlineMs: 1000, releasePinMs: 1000, maxReadRetries: 2,
  checkpointMs: 1000, checkpointRows: 256, fsyncBatchTargetMs: 20,
  watchdogMs: 250, stalledInputMs: 500, recoveryMs: 10_000,
  visibleActiveMs: 200, visibleIdleMs: 1000, visibleNoViewerMs: 5000,
  visibleEventMs: 50, visibleDeadlineMs: 1000,
  latencyP95Ms: 45, latencyP99Ms: 80, pairedUpperCi95Ms: 3, quietP95Ms: 50,
  stressLatencyRatio: 1.25, stressDrainMs: 25_000,
  normalMissingRows: 0, plannedMissingRows: 0, spikeFaultMissingRows: 0,
  unexpectedMarkedRowsPerPane: 5, unexpectedFaultRowsPerSecond: 2,
} as const);

/** Versioned canonical codec shared with C/D/Q. Object keys are sorted; arrays
 * retain order; undefined/nonfinite values are rejected instead of erased.
 * Pass the request WITHOUT its top-level digest. Nested digests are included.
 */
export function streamCanonical(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { if (!value.isWellFormed()) throw Error('invalid Unicode'); return JSON.stringify(value); }
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw Error('nonfinite number'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(streamCanonical).join(',') + ']';
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw Error('non-JSON value');
  const object = value as Record<string, unknown>;
  return '{' + Object.keys(object).sort().map(k => JSON.stringify(k) + ':' + streamCanonical(object[k])).join(',') + '}';
}
export function streamDigest(kind: string, payload: unknown): string {
  return createHash('sha256').update(streamCanonical({ version: STREAM_CONTRACT_VERSION, kind, payload })).digest('hex');
}

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
export interface InputPosition { readonly sourceEpoch: number; readonly packetSeq: number }
export interface EventId extends InputPosition { readonly pane: PaneKey; readonly scrollOrdinal: number }
export interface RowId { readonly pane: PaneKey; readonly lineId: number }
export interface RowRange { readonly start: number; readonly end: number }
export type Digest = string; // SHA-256 hex of canonical versioned payload, identity included.
export interface Geometry { readonly columns: number; readonly rows: number }
export interface StyleRun {
  readonly startCell: number; readonly endCell: number; readonly sgr: readonly number[];
}
export interface Cell {
  readonly text: string; readonly width: 0 | 1 | 2; readonly style: readonly number[];
}
export interface RowContent {
  readonly cells: readonly Cell[]; readonly softWrap: boolean; readonly wrapPad: number;
  readonly uncertainFields: readonly string[];
}
export interface FinalizedRow extends RowContent {
  readonly id: RowId; readonly revision: number; readonly source: EventId;
  readonly geometryGeneration: number; readonly geometry: Geometry;
}
/** Receive timestamp is host monotonic milliseconds, not wall time. */
export interface InputEvent {
  readonly identity: StreamIdentity; readonly position: InputPosition;
  readonly receivedAtMonoMs: number; readonly digest: Digest;
  readonly payload:
    | { readonly kind: 'bytes'; readonly bytes: readonly number[] }
    | { readonly kind: 'resize'; readonly geometry: Geometry }
    | { readonly kind: 'control'; readonly name: string; readonly data: string };
}
export interface FrameDelta {
  readonly identity: StreamIdentity; readonly screenRevision: number;
  readonly buffer: 'normal' | 'alternate'; readonly geometry: Geometry;
  readonly changedRows: readonly { readonly y: number; readonly content: RowContent }[];
  readonly cursor: Cursor; readonly overlap: RowRange | null;
}
export interface LiveFrame extends FrameDelta {
  readonly revision: number; readonly durableRevision: number;
  readonly head: number; // next lineId, exclusive; IDs never reused or renumbered.
}
export interface RamReceipt {
  readonly kind: 'ram'; readonly eventId: EventId; readonly digest: Digest;
  readonly revision: number; readonly head: number;
}
export interface DurableReceipt {
  readonly kind: 'durable'; readonly pane: PaneKey; readonly commitId: string;
  readonly digest: Digest; readonly durableRevision: number; readonly checkpointId: string;
}
export interface DurableInputReceipt {
  readonly kind: 'durable-input'; readonly pane: PaneKey;
  readonly through: InputPosition; readonly digest: Digest; readonly segmentId: string;
}
export type StreamFailure =
  | { readonly status: 'busy'; readonly retryAfterMs: number; readonly reason: 'pressure' | 'queue' | 'snapshot-gate' }
  | { readonly status: 'stale'; readonly reason: 'identity' | 'route' | 'geometry' | 'epoch' | 'late-gap' }
  | { readonly status: 'cancelled'; readonly reason: string }
  | { readonly status: 'error'; readonly code: 'integrity' | 'io' | 'unsupported' | 'unresolved-gap' | 'deadline'; readonly message: string };
export type Result<T> = { readonly status: 'ok'; readonly value: T } | StreamFailure;
/** eventId.scrollOrdinal is the first row ordinal of this bounded packet prefix.
 * Row j has ordinal start+j; each prefix advances revision once. */
export interface AppendFinalized {
  readonly identity: StreamIdentity; readonly eventId: EventId; readonly digest: Digest;
  readonly expectedRevision: number; readonly rows: readonly FinalizedRow[];
  readonly frameDelta: FrameDelta; readonly receivedAtMonoMs: number;
}

export interface Cursor { readonly x: number; readonly y: number; readonly visible: boolean }
export interface VtBuffer {
  readonly rows: readonly RowContent[]; readonly cursor: Cursor; readonly savedCursor: Cursor;
  readonly savedAttributes: readonly number[]; readonly savedModes: Readonly<Record<string, boolean | number>>;
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
  readonly codecVersion: string; readonly geometry: Geometry;
  readonly normal: VtBuffer; readonly alternate: VtBuffer; readonly active: 'normal' | 'alternate';
  readonly modes: Readonly<Record<string, boolean | number>>;
  readonly margins: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number };
  readonly tabStops: readonly number[]; readonly pendingUtf8: readonly number[];
  readonly pendingEscape: readonly number[]; readonly attributes: readonly number[];
  readonly wrapPending: boolean; readonly extensionState: string;
}
export interface VtCheckpoint {
  readonly kind: 'vt-recovery'; readonly checkpointId: string; readonly previousCheckpointId: string | null;
  readonly identity: StreamIdentity; readonly inputFence: DurableInputReceipt;
  readonly revision: number; readonly head: number; readonly state: VtState; readonly stateDigest: Digest;
}
export interface RowCursor { readonly lineId: number; readonly cellOffset: number }
export interface HistoryPageCheckpoint {
  readonly kind: 'history-page'; readonly blockId: string; readonly pane: PaneKey;
  readonly previousBlockId: string | null; readonly first: RowCursor; readonly end: RowCursor;
  readonly minRevision: number; readonly maxRevision: number; readonly checksum: Digest;
  readonly rowCount: number; readonly payloadBytes: number;
  readonly geometryAndWrap: readonly { readonly lineId: number; readonly geometryGeneration: number; readonly geometry: Geometry; readonly softWrap: boolean; readonly wrapPad: number }[];
}
export interface WalCheckpoint { readonly kind: 'sqlite-wal'; readonly busyReaders: number; readonly remainingFrames: number }
export interface CheckpointCommit {
  readonly checkpoint: VtCheckpoint; readonly expectedRevision: number;
  readonly commitId: string; readonly digest: Digest;
  /** Close only this fenced episode, after its final rows and verified VT restore. */
  readonly closeGap?: string;
}
export interface GapEpisode {
  readonly episodeId: string; readonly pane: PaneKey; readonly epochBefore: number; readonly epochAfter: number | null;
  readonly lastDurableInput: InputPosition | null; readonly lastAdmittedRow: number | null;
  readonly firstObservedAtMonoMs: number;
  readonly reason: 'eof' | 'reader-error' | 'worker-exit' | 'sequence' | 'ack-timeout' | 'checksum' | 'pressure' | 'identity' | 'geometry' | 'visible-divergence' | 'stalled-input' | 'late-gap';
  readonly status: 'suspected' | 'repairing' | 'unresolved' | 'repaired'; readonly missingCount: number | null;
}
export interface RepairChunk {
  readonly episode: GapEpisode; readonly chunkId: string; readonly digest: Digest;
  readonly expectedRevision: number; readonly rows: readonly FinalizedRow[];
  readonly final: boolean;
}
export interface RepairReceipt {
  readonly committedIds: readonly RowId[]; readonly committedRevision: number;
  readonly durable: DurableReceipt; readonly complete: boolean;
  readonly finalChunk?: boolean; // rows sealed; complete requires repaired checkpoint ACK
}
/** Yield each committed chunk immediately. Later failure cannot erase that prefix. */
export type RecoveryChunk =
  | { readonly kind: 'checkpoint'; readonly checkpoint: VtCheckpoint }
  | { readonly kind: 'input'; readonly event: InputEvent }
  | { readonly kind: 'rows'; readonly rows: readonly FinalizedRow[]; readonly receipt: DurableReceipt };

export interface ReadRequest {
  readonly requestId: string; readonly identity: StreamIdentity; readonly routeGeneration: number;
  readonly range: RowRange; readonly deadlineMonoMs: number;
}
export interface ReadView extends ReadRequest {
  readonly grantRevision: number; readonly durableAtGrant: number; readonly headAtGrant: number;
  readonly overlayHandle: string;
}
export interface ReadOpenAck {
  readonly view: ReadView; readonly diskSnapshotRevision: number;
  readonly snapshotHandle: string; // same established transaction for all page reads.
}
export interface PageCursor extends RowCursor {
  readonly requestId: string; readonly direction: 'before' | 'after';
}
/** Large rows/logical lines continue at cellOffset; byte truncation is never EOF. */
export interface RowFragment {
  readonly row: FinalizedRow; readonly startCell: number; readonly endCell: number;
  readonly complete: boolean; // row.cells contains only this fragment.
}
export interface HistoryPage {
  readonly view: ReadView; readonly fragments: readonly RowFragment[]; readonly payloadBytes: number;
  readonly nextBefore: PageCursor | null; readonly nextAfter: PageCursor | null;
  readonly hasMoreBefore: boolean; readonly hasMoreAfter: boolean;
}
export interface CancelToken { readonly isCancelled: () => boolean }
export interface CaptureEngine {
  /** Reserve before mutation; busy retries exact same event/digest. */
  acceptInput(event: InputEvent): Promise<Result<DurableInputReceipt>>;
  checkpoint(pane: PaneKey, reason: 'periodic' | 'row-limit' | 'handoff'): Promise<Result<VtCheckpoint>>;
  restore(checkpoint: VtCheckpoint, input: AsyncIterable<InputEvent>): Promise<Result<LiveFrame>>;
  checkVisible(identity: StreamIdentity): Promise<Result<{ readonly verdict: 'equal' | 'different' | 'unfenced' }>>;
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
export interface ViewerRoute { readonly viewerId: string; readonly identity: StreamIdentity; readonly routeGeneration: number }
export interface DisplayEngine {
  attach(route: ViewerRoute, onFrame: (frame: LiveFrame) => void): Promise<Result<LiveFrame>>;
  page(route: ViewerRoute, request: ReadRequest, cursor: PageCursor | null, limit: number, cancel: CancelToken): Promise<Result<HistoryPage>>;
  detach(route: ViewerRoute, reason: string): Promise<void>;
}
export type MemoryOwner = 'vt' | 'tail' | 'raw' | 'metadata' | 'pending' | 'scratch' | 'disk-cache' | 'display-pages' | 'ws' | 'unattributed';
export type StreamMetric =
  | { readonly kind: 'memory'; readonly atMonoMs: number; readonly owner: MemoryOwner; readonly pane: PaneKey | null; readonly heldBytes: number; readonly capacityBytes: number }
  | { readonly kind: 'publish'; readonly eventId: EventId; readonly receivedAtMonoMs: number; readonly ramPublishedAtMonoMs: number; readonly durableAtMonoMs: number | null }
  | { readonly kind: 'request'; readonly requestId: string; readonly pane: PaneKey; readonly operation: 'visible' | 'page' | 'repair'; readonly eligibleAtMonoMs: number; readonly deadlineMonoMs: number; readonly completedAtMonoMs: number | null; readonly outcome: 'pending' | 'ok' | 'busy' | 'unfenced' | 'cancelled' | 'error' }
  | { readonly kind: 'gap'; readonly episode: GapEpisode }
  | { readonly kind: 'lifecycle'; readonly identity: StreamIdentity; readonly atMonoMs: number; readonly reason: string; readonly errorStack: string | null }
  | { readonly kind: 'pss'; readonly atMonoMs: number; readonly processes: readonly { readonly pid: number; readonly startTime: string; readonly role: string; readonly pssBytes: number | null }[]; readonly valid: boolean };
export interface StreamObserver { record(metric: StreamMetric): void }

/** Unambiguous keys, unlike delimiter concatenation; validate counters at ingress. */
export function eventKey(id: EventId): string {
  return JSON.stringify([id.pane.serverIdentity, id.pane.paneId, id.pane.birthGeneration, id.sourceEpoch, id.packetSeq, id.scrollOrdinal]);
}
export function rowKey(id: RowId): string {
  return JSON.stringify([id.pane.serverIdentity, id.pane.paneId, id.pane.birthGeneration, id.lineId]);
}
export function validReadOpen(ack: ReadOpenAck): boolean {
  const v = ack.view;
  return [v.durableAtGrant, ack.diskSnapshotRevision, v.grantRevision, v.headAtGrant, v.range.start, v.range.end].every(n => Number.isSafeInteger(n) && n >= 0)
    && v.durableAtGrant <= ack.diskSnapshotRevision && ack.diskSnapshotRevision <= v.grantRevision
    && v.range.start <= v.range.end && v.range.end <= v.headAtGrant;
}

// Flag-on revision 1 (Q21). These ports are independent of the legacy engines
// above. No adapter may silently reinterpret a legacy lineId/epoch/checkpoint.
import type {
  NewarchCapabilities, NewarchGap, NewarchHistoryCursor, NewarchHistoryExtension,
  NewarchHistoryState, NewarchRowId, NewarchRowRange,
} from '../../core/src/protocol';
export type { NewarchCapabilities, NewarchHistoryCursor, NewarchHistoryState } from '../../core/src/protocol';
export const FLAGON_VERSIONS = Object.freeze({ stitch: 1, capture: 1, spool: 1, receipt: 1, bundle: 1, catalog: 3, history: 1 } as const);
/** Fixed budgets; fault loss has no numerical ceiling under Q21. Legacy B's
 * spikeFaultMissingRows/unexpectedMarkedRowsPerPane are NOT flag-on gates. */
export const FLAGON_BUDGET = Object.freeze({
  processTreePssHardBytes: 1536 * MiB, plateauMinMs: 180 * 60_000, plateauMaxDeltaBytes: 10 * MiB,
  normalMissingRows: 0, plannedMissingRows: 0, faultMissingRowsLimit: null,
  tailSearchRows: 512, searchChunkRows: 256, retainedHistoryRows: 4500,
  minAnchorRows: 8, minDistinctKeys: 4, minNonblankRows: 2, maxCandidates: 4096, stitchDeadlineMs: 100,
  captureCountPerEpisode: 1, rawBytesPerPane: 256 * 1024, stagingBytesGlobal: 16 * MiB,
  scratchBytes: 32 * MiB, restoreCacheBytes: 32 * MiB, archiveChunkBytes: 16 * MiB,
  canaryRootCapBytes: 256 * MiB, reserveBytes: 16 * MiB, reservePerPaneBytes: 256 * 1024,
  reserveSharedBytes: 8 * MiB, archiveConcurrency: 1, archivePollMs: 30_000,
  archiveStartFsPercent: 75, archiveStartRootPercent: 75, archiveStartTimeToFullMs: 30 * 60_000,
  archiveStopFsPercent: 70, archiveStopRootPercent: 65, archiveStopReserveMultiple: 2,
  archiveStopTimeToFullMs: 60 * 60_000, criticalFsPercent: 90, criticalRootPercent: 90,
  criticalRateHorizonMs: 10 * 60_000, healthPollMs: 1000, incidentDeadlineMs: 2000,
  recoveryMs: 10_000, reconnectBackoffMs: Object.freeze([100, 500, 1000, 2000] as const),
} as const);
export type SegmentRowId = NewarchRowId;
export type SegmentRowRange = NewarchRowRange;
export type Gap = NewarchGap;
export interface PipeEpoch {
  readonly pane: PaneKey; readonly attachId: string; readonly collectorIncarnation: string;
}
export interface RawPosition { readonly epoch: PipeEpoch; readonly byteOffset: number }
export interface RawRange { readonly epoch: PipeEpoch; readonly start: number; readonly end: number }
export type Coverage = readonly (
  | { readonly kind: 'rows'; readonly range: SegmentRowRange; readonly digest: Digest }
  | { readonly kind: 'gap'; readonly gap: Gap; readonly digest: Digest }
)[];
export interface EvidenceFile { readonly path: string; readonly bytes: number; readonly sha256: Digest }
export interface ProcessIdentity { readonly pid: number; readonly startTime: string; readonly bootId: string }
export interface OperationFence {
  readonly operationId: string; readonly pane: PaneKey; readonly expectedGeneration: number;
}
export interface AttachIntent extends OperationFence {
  readonly attachId: string; readonly episodeId: string; readonly parentEpisodeId: string | null;
  readonly kind: 'birth' | 'recovery'; readonly rootUUID: string;
}
export interface CollectorBinding {
  readonly kind: 'collector-binding'; readonly epoch: PipeEpoch; readonly attachId: string;
  readonly rootUUID: string; readonly bootNonce: string; readonly ownerGeneration: number;
  readonly process: ProcessIdentity; readonly peerUid: number; readonly fifoId: string;
  readonly handshakeId: string; readonly artifactSha256: Digest;
}
export type Binding = CollectorBinding;
/** Evidence must be checked against the actual binary/hooks/identity/geometry.
 * A caller-supplied boolean or matching content is never a boundary proof. */
export type BoundaryEvidence =
  | { readonly kind: 'certified-same-turn'; readonly pane: PaneKey; readonly epoch: PipeEpoch;
      readonly geometry: Geometry; readonly binarySha256: Digest; readonly hookConfigSha256: Digest;
      readonly transcript: EvidenceFile; readonly eventCoverage: EvidenceFile;
      readonly pipeOpenEvent: string; readonly captureStartEvent: string; readonly captureEndEvent: string;
      readonly rawStart: RawPosition; readonly certificateId: string }
  | { readonly kind: 'birth'; readonly pane: PaneKey; readonly epoch: PipeEpoch;
      readonly genesis: VtCheckpoint; readonly firstByteOffset: 0; readonly transcript: EvidenceFile }
  | { readonly kind: 'overlap-unknown'; readonly reason: 'wait' | 'hook' | 'split-command' | 'identity' | 'geometry' | 'command-error' | 'parse' };
export interface CapturePacket {
  readonly version: 1; readonly snapshotId: string; readonly episodeId: string; readonly captureCount: 1;
  readonly complete: true;
  readonly pane: PaneKey; readonly geometry: Geometry; readonly geometryGeneration: number;
  readonly historySize: number; readonly historyLimit: number; readonly cursor: Cursor;
  readonly activeBuffer: 'normal' | 'alternate' | 'unknown'; readonly mainHistory: 'available' | 'uncertain' | 'unavailable';
  readonly snapshot: EvidenceFile; readonly commandTranscript: EvidenceFile;
  readonly rawRange: RawRange; readonly boundary: BoundaryEvidence;
  readonly startedAtMonoMs: number; readonly endedAtMonoMs: number; readonly clockEpoch: string;
  readonly stateKnown: Readonly<Record<string, boolean>>;
}
/** No success variant for truncated capture. Birth can carry a certified empty
 * capture packet; no second capture is allowed after an uncertain crash. */
export interface OpenCapture { readonly packet: CapturePacket; readonly binding: Binding; readonly durable: SpoolAck }
export interface SourceTransportPort {
  openBirth(intent: AttachIntent, cancel: CancelToken): Promise<Result<OpenCapture>>;
  openRecovery(intent: AttachIntent, cancel: CancelToken): Promise<Result<OpenCapture>>;
}
export type RowOrigin =
  | { readonly kind: 'durable'; readonly rowId: SegmentRowId }
  | { readonly kind: 'capture'; readonly snapshotId: string; readonly rowIndex: number }
  | { readonly kind: 'pipe'; readonly range: RawRange; readonly ordinal: number };
export interface StitchRow {
  readonly origin: RowOrigin; readonly cells: readonly Cell[]; readonly geometry: Geometry;
  readonly buffer: 'normal' | 'alternate'; readonly wrapStatus: 'wrapped' | 'unwrapped' | 'unknown';
  readonly wrapPad: number; readonly finalized: boolean; readonly uncertainFields: readonly string[];
  readonly cellOrigins: readonly RowOrigin[];
}
export interface StitchWindow { readonly pane: PaneKey; readonly rows: readonly StitchRow[] }
export interface CaptureWindow extends StitchWindow { readonly packet: CapturePacket }
export interface PipeWindow extends StitchWindow { readonly rawRange: RawRange }
export interface StitchPolicy {
  readonly version: 1; readonly minAnchorRows: 8; readonly minDistinctKeys: 4;
  readonly minNonblankRows: 2; readonly maxCandidates: 4096; readonly deadlineMs: 100;
}
export type SeamProof =
  | { readonly kind: 'recorded-mapping'; readonly range: RawRange; readonly checkpointId: string;
      readonly mapping: EvidenceFile; readonly coverage: Coverage }
  | { readonly kind: 'independent-boundary'; readonly boundary: Exclude<BoundaryEvidence, { readonly kind: 'overlap-unknown' }> };
export interface StitchProofs {
  readonly policy: StitchPolicy; readonly episodeId: string;
  readonly tailToCapture: readonly SeamProof[]; readonly captureToPipe: readonly SeamProof[];
}
export interface AcceptedRowMap { readonly source: RowOrigin; readonly target: SegmentRowId }
export interface WithheldRange {
  readonly source: 'tail' | 'capture' | 'pipe'; readonly start: number; readonly end: number;
  readonly reason: 'ambiguous' | 'unproven' | 'unknown-state';
}
export interface StitchDecision {
  readonly decisionId: string; readonly acceptedRowMap: readonly AcceptedRowMap[];
  readonly withheldRanges: readonly WithheldRange[]; readonly gaps: readonly Gap[];
}
export type StitchResult =
  | (StitchDecision & { readonly status: 'matched'; readonly proofs: StitchProofs })
  | (StitchDecision & { readonly status: 'ambiguous'; readonly reason: 'multiple-alignments' | 'candidate-limit'; readonly candidateCount: number })
  | (StitchDecision & { readonly status: 'unproven'; readonly reason: 'content-only' | 'unknown-state' | 'geometry' | 'deadline' | 'short-anchor' })
  | { readonly status: 'error'; readonly code: 'integrity' | 'identity' | 'io'; readonly message: string };
export interface StitchPort {
  stitch(T: StitchWindow, C: CaptureWindow, P: PipeWindow, proofs: StitchProofs): Promise<StitchResult>;
}
export interface SpoolRecord {
  readonly version: 1; readonly operationId: string; readonly range: RawRange;
  readonly sequence: number; readonly previousDigest: Digest | null; readonly digest: Digest;
  readonly payload: { readonly kind: 'bytes'; readonly bytes: readonly number[] }
    | { readonly kind: 'resize'; readonly geometry: Geometry }
    | { readonly kind: 'control'; readonly name: string; readonly data: string };
}
/** Issued only after sync; byte offsets are collector receive positions. */
export interface SpoolAck {
  readonly kind: 'synced-spool'; readonly version: 1; readonly through: RawPosition;
  readonly recordDigest: Digest; readonly commitId: string; readonly segmentId: string;
}
export interface CommittedStreamRow extends StitchRow { readonly id: SegmentRowId }
export interface RowsAndGapsCommit extends OperationFence {
  readonly rows: readonly CommittedStreamRow[]; readonly coverage: Coverage; readonly decision: StitchDecision;
  readonly inputAck: SpoolAck; readonly checkpointId: string | null; readonly digest: Digest;
}
export interface RowsAndGapsReceipt {
  readonly kind: 'rows-gaps-durable'; readonly operationId: string; readonly commitId: string;
  readonly generation: number; readonly coverage: Coverage; readonly digest: Digest;
}
export type FlagOnRecoveryChunk =
  | { readonly kind: 'input'; readonly record: SpoolRecord; readonly ack: SpoolAck }
  | { readonly kind: 'committed'; readonly rows: readonly CommittedStreamRow[]; readonly gaps: readonly Gap[]; readonly receipt: RowsAndGapsReceipt }
  | { readonly kind: 'checkpoint'; readonly checkpoint: VtCheckpoint }
  | { readonly kind: 'truncated-tail'; readonly discardedRange: RawRange; readonly lastAck: SpoolAck | null };
export interface PinRequest extends OperationFence {
  readonly segmentId: string; readonly reason: 'reader' | 'attach' | 'handoff' | 'replay' | 'checkpoint' | 'restore';
}
export interface SegmentPin extends PinRequest { readonly pinId: string; readonly durableCommitId: string }
export interface SealedExport {
  readonly kind: 'sealed-export'; readonly operationId: string; readonly storeUUID: string;
  readonly pane: PaneKey; readonly segmentId: string; readonly generation: number;
  readonly coverage: Coverage; readonly files: readonly EvidenceFile[]; readonly manifest: EvidenceFile;
  readonly sealCommitId: string;
}
export interface RemoteObject {
  readonly objectKey: string; readonly bytes: number; readonly sha256: Digest;
}
export interface ArchiveBundle {
  readonly version: 1; readonly bundleId: string; readonly storeUUID: string;
  readonly pane: PaneKey; readonly segmentId: string; readonly coverage: Coverage;
  readonly schemaVersions: Readonly<Record<string, number>>;
  readonly objects: readonly RemoteObject[]; readonly manifest: RemoteObject;
  readonly members: readonly EvidenceFile[]; readonly compression: 'tar.zst'; readonly encryption: 'none';
  readonly checkpointIds: readonly string[]; readonly rawRanges: readonly RawRange[];
}
export interface VerifiedBundle {
  readonly kind: 'verified-remote'; readonly bundle: ArchiveBundle; readonly verificationId: string;
  readonly method: 'download-sha256' | 'rclone-check-download'; readonly verifiedAtMonoMs: number;
  readonly clockEpoch: string; readonly inventoryDigest: Digest; readonly evidence: readonly EvidenceFile[];
  readonly toolVersion: string; readonly command: readonly string[];
  readonly stdout: EvidenceFile; readonly stderr: EvidenceFile; readonly exitCode: 0;
}
export interface RemoteIndexReceipt {
  readonly kind: 'remote-index-committed'; readonly catalogVersion: 3; readonly commitId: string;
  readonly generation: number; readonly verified: VerifiedBundle; readonly coverage: Coverage;
}
export interface ReclaimReceipt {
  readonly kind: 'local-reclaimed'; readonly remote: RemoteIndexReceipt; readonly removed: readonly EvidenceFile[];
  readonly allocatedBytesBefore: number; readonly allocatedBytesAfter: number;
  readonly freeBlocksBefore: number; readonly freeBlocksAfter: number; readonly blockBytes: number;
}
export interface FlagOnHistoryPort {
  appendInput(record: SpoolRecord): Promise<Result<SpoolAck>>;
  /** One durable transaction: rows + gaps + mapping/decision + checkpoint reference. */
  commitRowsAndGaps(request: RowsAndGapsCommit): Promise<Result<RowsAndGapsReceipt>>;
  recover(pane: PaneKey, after: RawPosition | null, cancel: CancelToken): AsyncIterable<Result<FlagOnRecoveryChunk>>;
  sealExport(request: OperationFence & { readonly segmentId: string }): Promise<Result<SealedExport>>;
  pinSegment(request: PinRequest): Promise<Result<SegmentPin>>;
  releasePin(pin: SegmentPin): Promise<Result<null>>;
  /** Recheck pins AND generation in reclaim transaction. Never delete hot WAL. */
  reclaimVerified(request: OperationFence & { readonly sealed: SealedExport; readonly remote: RemoteIndexReceipt }): Promise<Result<ReclaimReceipt>>;
}

export interface FiniteCut { readonly pane: PaneKey; readonly lastRow: SegmentRowId | null; readonly rawThrough: RawPosition }
export interface PhysicalIndexEntry {
  readonly coverageIndex: number; readonly fileId: string; readonly start: number; readonly end: number;
}
/** Exact batch is intentionally separate from appendCutoverSeal's overlap API. */
export interface ExactBatch extends OperationFence {
  readonly handoffId: string; readonly archiveIncarnation: string; readonly epochs: readonly PipeEpoch[];
  readonly cut: FiniteCut; readonly rows: readonly CommittedStreamRow[]; readonly coverage: Coverage;
  readonly digest: Digest;
}
export interface LegacyRangeReceipt {
  readonly version: 1; readonly kind: 'legacy-range-durable'; readonly operationId: string;
  readonly handoffId: string; readonly pane: PaneKey; readonly ownerGeneration: number;
  readonly epochs: readonly PipeEpoch[]; readonly archiveIncarnation: string; readonly cut: FiniteCut;
  readonly coverage: Coverage; readonly coverageDigest: Digest; readonly physicalIndexMap: readonly PhysicalIndexEntry[];
  readonly files: readonly EvidenceFile[]; readonly durableCommitId: string;
}
/** A validates by reading the receipt's exact row/gap coverage back from disk. */
export interface ValidatedLegacyReceipt {
  readonly kind: 'validated-legacy-receipt'; readonly receipt: LegacyRangeReceipt;
  readonly validationId: string; readonly readbackDigest: Digest;
}
export interface WriterBindRequest extends OperationFence {
  readonly handoffId: string; readonly writer: ProcessIdentity; readonly leaseGeneration: number;
  readonly subscriptionId: string; readonly after: FiniteCut; readonly archiveIncarnation: string;
}
export interface WriterBinding extends WriterBindRequest {
  readonly kind: 'current-writer-binding'; readonly bindingId: string; readonly handshakeId: string;
}
export interface SuffixPin {
  readonly kind: 'durable-suffix-pin'; readonly cut: FiniteCut; readonly pin: SegmentPin;
  readonly through: SpoolAck; readonly checkpointId: string | null;
}
export interface LegacyWriterPort {
  appendExactBatch(batch: ExactBatch): Promise<Result<LegacyRangeReceipt>>;
  bindLegacyWriter(request: WriterBindRequest): Promise<Result<WriterBinding>>;
}
export type AttachState = 'ATTACH_INTENT' | 'PIPE_OPEN' | 'CAPTURED' | 'COMMITTED' | 'ABORTING' | 'ABORTED';
export interface AttachDecision {
  readonly attachId: string; readonly generation: number; readonly commitId: string;
  readonly state: AttachState; readonly admission: 'active-exact' | 'active-degraded' | null;
}
export interface CommitAttachRequest extends OperationFence {
  readonly attachId: string; readonly binding: Binding; readonly packet: CapturePacket;
  readonly durable: RowsAndGapsReceipt; readonly admission: 'active-exact' | 'active-degraded';
}
export type HandoffState = 'STREAM_ACTIVE' | 'HANDOFF_INTENT' | 'PREPARED' | 'DEST_DURABLE' | 'DEST_BOUND' | 'COMMITTED' | 'RELEASED';
export interface HandoffIntent extends OperationFence { readonly handoffId: string; readonly cut: FiniteCut }
export interface PreparedHandoff {
  readonly state: 'PREPARED'; readonly intent: HandoffIntent; readonly prefix: Coverage;
  readonly pendingToken: NewarchHistoryCursor; readonly suffix: SuffixPin;
}
export interface CommitHandoffRequest {
  readonly prepared: PreparedHandoff; readonly receipt: ValidatedLegacyReceipt;
  readonly binding: WriterBinding; readonly suffix: SuffixPin;
}
export interface HandoffDecision {
  readonly state: 'COMMITTED' | 'RELEASED'; readonly handoffId: string;
  readonly generation: number; readonly commitId: string; readonly receiptCommitId: string;
}
export type PendingRecovery =
  | { readonly kind: 'pending'; readonly prepared: PreparedHandoff; readonly reason: 'unverified-receipt' | 'writer-unbound' | 'suffix-unpinned' | 'storage' }
  | { readonly kind: 'committed'; readonly decision: HandoffDecision };
export type SegmentLocation =
  | { readonly kind: 'local'; readonly range: SegmentRowRange; readonly files: readonly EvidenceFile[] }
  | { readonly kind: 'remote-required'; readonly range: SegmentRowRange; readonly remote: RemoteIndexReceipt }
  | { readonly kind: 'restored'; readonly range: SegmentRowRange; readonly cacheId: string; readonly remote: RemoteIndexReceipt }
  | { readonly kind: 'remote-unavailable'; readonly range: SegmentRowRange; readonly bundleId: string; readonly reason: 'offline' | 'missing' | 'corrupt'; readonly retryAfterMs: number };
export interface ArchiveCatalogPort {
  beginAttach(intent: AttachIntent): Promise<Result<AttachDecision>>;
  /** Must not abort a committed owner; only remove this attachId+generation. */
  abortAttach(request: OperationFence & { readonly attachId: string; readonly reason: string }): Promise<Result<AttachDecision>>;
  commitAttach(request: CommitAttachRequest): Promise<Result<AttachDecision>>;
  prepareHandoff(intent: HandoffIntent, suffix: SuffixPin): Promise<Result<PreparedHandoff>>;
  /** Catalog atomically commits owner + segment + receipt ref + decision. */
  commitHandoff(request: CommitHandoffRequest): Promise<Result<HandoffDecision>>;
  recoverPending(pane: PaneKey, cancel: CancelToken): Promise<Result<PendingRecovery>>;
  commitRemoteIndex(request: OperationFence & { readonly sealed: SealedExport; readonly verified: VerifiedBundle }): Promise<Result<RemoteIndexReceipt>>;
  getLocation(range: SegmentRowRange): Promise<Result<SegmentLocation>>;
}
export type ArchiveState = 'SEALED_LOCAL' | 'UPLOADING' | 'UPLOADED_UNVERIFIED' | 'VERIFIED_REMOTE' | 'REMOTE_COMMITTED' | 'LOCAL_RECLAIMED' | 'CORRUPT_REMOTE';
export interface StoragePressure {
  readonly sampledAtMonoMs: number; readonly clockEpoch: string;
  readonly filesystemUsedPercent: number | null; readonly rootAllocatedBytes: number;
  readonly rootHardCapBytes: number; readonly usableFreeBytes: number | null;
  readonly rate15minBytesPerSecond: number | null; readonly reserveBytes: number;
  readonly sampleAgeMs: number; readonly ioError: 'ENOSPC' | 'EIO' | null;
}
export interface ArchiveAttempt {
  readonly operationId: string; readonly state: ArchiveState; readonly bundleId: string;
  readonly retryAfterMs: number | null; readonly verified: VerifiedBundle | null;
  readonly reclaimed: ReclaimReceipt | null;
}
export interface RestoreRequest {
  readonly operationId: string; readonly storeUUID: string; readonly range: SegmentRowRange;
  readonly inventory: RemoteObject; readonly allowedRoot: string;
}
export interface RestoredRange {
  readonly kind: 'restored-immutable'; readonly cacheId: string; readonly range: SegmentRowRange;
  readonly verified: VerifiedBundle; readonly files: readonly EvidenceFile[]; readonly coverage: Coverage;
  readonly installCommitId: string;
}
export interface ArchiveWorkerPort {
  archiveOnce(pressure: StoragePressure, cancel: CancelToken): Promise<Result<ArchiveAttempt | { readonly state: 'idle'; readonly reason: 'below-threshold' | 'pinned' | 'backoff' }>>;
  verifyBundle(bundle: ArchiveBundle, cancel: CancelToken): Promise<Result<VerifiedBundle>>;
  restoreRange(request: RestoreRequest, cancel: CancelToken): Promise<Result<RestoredRange>>;
}
/** Optional on old records; mandatory in the separate flag-on interfaces below. */
export interface ReadView { readonly flagOn?: FlagOnReadExtension }
export interface HistoryPage { readonly flagOn?: NewarchHistoryExtension }
export interface FlagOnReadExtension {
  readonly version: 1; readonly capabilities: NewarchCapabilities; readonly committedPrefix: Coverage;
  readonly cursor: NewarchHistoryCursor; readonly states: readonly NewarchHistoryState[];
}
export interface FlagOnReadView extends ReadView { readonly flagOn: FlagOnReadExtension }
export interface FlagOnHistoryPage {
  readonly view: FlagOnReadView; readonly rows: readonly CommittedStreamRow[];
  readonly payloadBytes: number; readonly flagOn: NewarchHistoryExtension;
}
export interface EpisodeObservation {
  readonly atMonoMs: number; readonly clockEpoch: string; readonly epoch: PipeEpoch;
  readonly episodeId: string; readonly phase: 'trigger' | 'resolve'; readonly reason: string;
  readonly captureCount: number; readonly eventCoverage: number | null; readonly rawBytes: number;
  readonly gap: Gap | null; readonly rawRecoveredAtMonoMs: number | null; readonly exactDisplayAtMonoMs: number | null;
}
export interface ArchiveObservation {
  readonly atMonoMs: number; readonly clockEpoch: string; readonly epoch: PipeEpoch;
  readonly operationId: string; readonly state: ArchiveState; readonly physicalLocalBytes: number | null;
  readonly remoteVerifiedBytes: number | null; readonly spoolBytes: number | null;
  readonly scratchBytes: number | null; readonly cacheBytes: number | null; readonly pressure: StoragePressure;
}
export interface MemoryObservation {
  readonly atMonoMs: number; readonly clockEpoch: string; readonly epoch: PipeEpoch;
  readonly processes: readonly { readonly identity: ProcessIdentity; readonly role: 'host' | 'collector' | 'vt' | 'fifo' | 'archive' | 'observer'; readonly pssBytes: number | null }[];
  readonly expectedProcesses: readonly ProcessIdentity[]; readonly coverage: number | null;
  readonly rawBytes: number; readonly stagingBytes: number; readonly physicalDiskBytes: number | null;
}
export interface FlagOnObserver {
  observeEpisode(observation: EpisodeObservation): void;
  observeArchive(observation: ArchiveObservation): void;
  observeMemory(observation: MemoryObservation): void;
}
/** Non-operational placeholder only. There is deliberately no default runtime. */
export function flagOnNotImplemented(port: string): never {
  throw new Error(`NEWARCH flag-on implementation required: ${port}`);
}
