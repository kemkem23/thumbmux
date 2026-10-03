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
/** Durable/legacy style is canonical full-state SGR parameters, with implicit
 * reset before each cell. Never [attrs, fg, bg]. Text retains combining codepoints;
 * width 0 is a continuation slot, not permission to drop text during conversion. */
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

// K-r2 repair extension. v1 records, hashes and ports above are immutable.
// New implementations explicitly implement the R2 ports; no optional-method
// fallback may turn an unsupported operation into success.
export const FLAGON_REPAIR_REVISION = 2 as const;
export const FLAGON_REPAIR_LIMITS = Object.freeze({ receiptSetEntries: 256, chunkRows: 256,
  chunkBytes: MiB, receiptSetBytes: MiB, readEntries: 256, readBytes: MiB } as const);
const sameContract = (a: unknown, b: unknown): boolean => streamCanonical(a) === streamCanonical(b);
function contractUint(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw Error('contract unsafe counter');
}
function contractHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('contract invalid SHA-256');
}

/** Semantic decoder style, NEVER Cell.style. attrs bits 0..8 = SGR 1..9,
 * bit 9 = SGR 21. fg/bg: -1 default, 0..255 index, 256+0xRRGGBB RGB.
 * Unsupported attributes fail, they are never silently discarded. */
export interface SemanticStyle { readonly attrs: number; readonly fg: number; readonly bg: number }
export interface SemanticCell { readonly text: string; readonly width: 0 | 1 | 2; readonly style: SemanticStyle }
export function semanticStyleToSgr(style: SemanticStyle): number[] {
  contractUint(style.attrs);
  if (style.attrs > 1023) throw Error('unsupported semantic attributes');
  const sgr: number[] = [];
  for (let n = 1; n <= 9; n++) if (style.attrs & (1 << (n - 1))) sgr.push(n);
  if (style.attrs & 512) sgr.push(21);
  const color = (c: number, base: number, bright: number, extended: number) => {
    if (!Number.isSafeInteger(c) || c < -1 || c > 0xffffff + 256) throw Error('unsupported semantic color');
    if (c === -1) return;
    if (c < 8) sgr.push(base + c);
    else if (c < 16) sgr.push(bright + c - 8);
    else if (c < 256) sgr.push(extended, 5, c);
    else { const rgb = c - 256; sgr.push(extended, 2, rgb >>> 16, (rgb >>> 8) & 255, rgb & 255); }
  };
  color(style.fg, 30, 90, 38); color(style.bg, 40, 100, 48);
  return sgr;
}
/** Accept canonical full-state parameters only (implicit reset before each
 * cell). [] = default. Reject reset/off codes, aliases, duplicates, reordered
 * params and unknown SGR; parsing arbitrary ANSI is the decoder's job. */
export function sgrToSemanticStyle(sgr: readonly number[]): SemanticStyle {
  let attrs = 0, fg = -1, bg = -1;
  for (let i = 0; i < sgr.length; i++) {
    const n = sgr[i]!; contractUint(n);
    if (n >= 1 && n <= 9) attrs |= 1 << (n - 1);
    else if (n === 21) attrs |= 512;
    else if (n >= 30 && n <= 37) fg = n - 30;
    else if (n >= 90 && n <= 97) fg = n - 90 + 8;
    else if (n >= 40 && n <= 47) bg = n - 40;
    else if (n >= 100 && n <= 107) bg = n - 100 + 8;
    else if (n === 38 || n === 48) {
      const mode = sgr[++i];
      const byte = () => { const v = sgr[++i]!; contractUint(v); if (v > 255) throw Error('SGR color byte'); return v; };
      let c: number;
      if (mode === 5) c = byte();
      else if (mode === 2) c = 256 + byte() * 65536 + byte() * 256 + byte();
      else throw Error('unsupported SGR color mode');
      if (n === 38) fg = c; else bg = c;
    } else throw Error('noncanonical SGR');
  }
  const style = { attrs, fg, bg };
  if (!sameContract(semanticStyleToSgr(style), sgr)) throw Error('noncanonical SGR order/alias');
  return style;
}
export function semanticCellToCell(cell: SemanticCell): Cell {
  if (![0, 1, 2].includes(cell.width) || !cell.text.isWellFormed()) throw Error('invalid cell');
  return { text: cell.text, width: cell.width, style: semanticStyleToSgr(cell.style) };
}
export function cellToSemanticCell(cell: Cell): SemanticCell {
  if (![0, 1, 2].includes(cell.width) || !cell.text.isWellFormed()) throw Error('invalid cell');
  return { text: cell.text, width: cell.width, style: sgrToSemanticStyle(cell.style) };
}

/** Normalized projection uses W's existing v1 formula; old H receipts retain
 * their original digest. H emits a separately stored CoverageProjectionR2. */
export function normalizedRowsDigest(range: SegmentRowRange, rows: readonly CommittedStreamRow[]): Digest {
  return streamDigest('newarch-legacy-coverage-rows', { range, rows: rows.map(row => ({
    id: row.id, cells: row.cells, wrapStatus: row.wrapStatus, wrapPad: row.wrapPad, buffer: row.buffer,
  })) });
}
export function normalizedGapDigest(gap: Gap): Digest { return streamDigest('newarch-legacy-coverage-gap', gap); }
export function normalizedCoverageDigest(coverage: Coverage): Digest { return streamDigest('newarch-legacy-receipt-coverage', coverage); }
export interface CoverageProjectionR2 {
  readonly revision: 2; readonly sourceCommitId: string; readonly sourceDigest: Digest;
  readonly sourceDomain: 'rows-gaps-v1'; readonly coverage: Coverage; readonly coverageDigest: Digest;
  readonly projectionDigest: Digest;
}
export function coverageProjectionDigest(proof: Omit<CoverageProjectionR2, 'projectionDigest'>): Digest {
  return streamDigest('coverage-projection-r2', proof);
}
export interface LegacyReadbackR2 {
  readonly kind: 'legacy-readback-r2'; readonly revision: 2; readonly receiptCommitId: string;
  readonly coverageDigest: Digest; readonly readbackDigest: Digest;
}
export interface PhysicalReadbackR2 {
  readonly durableCommitId: string; readonly coverageDigest: Digest;
  readonly files: readonly EvidenceFile[]; readonly physicalIndexMap: readonly PhysicalIndexEntry[];
  /** SHA-256(JSON.stringify(lines)) per ordered coverage entry, after disk read. */
  readonly lineSha: readonly Digest[];
}
export function physicalReadbackDigest(readback: PhysicalReadbackR2): Digest {
  return streamDigest('legacy-physical-readback-r2', readback);
}
/** Equality of a claimed proof and W's authoritative synchronous disk read.
 * NOT an authority by itself: passing the claim twice proves nothing. A must
 * additionally validate receipt identity/coverage/current binding/suffix pin. */
export function legacyReadbackMatches(claimed: LegacyReadbackR2, authority: LegacyReadbackR2): boolean {
  return claimed.kind === 'legacy-readback-r2' && authority.kind === claimed.kind
    && claimed.revision === 2 && authority.revision === 2 && claimed.receiptCommitId.length > 0
    && /^[a-f0-9]{64}$/.test(claimed.coverageDigest) && /^[a-f0-9]{64}$/.test(claimed.readbackDigest)
    && sameContract(claimed, authority);
}
export interface SourceChainSliceR2 {
  readonly range: RawRange; readonly firstSequence: number; readonly lastSequence: number;
  readonly previousDigest: Digest | null; readonly terminalDigest: Digest;
  readonly sourceDomain: 'spool-record'; readonly recordsDigest: Digest;
}
export interface CoalescedInputR2 {
  readonly revision: 2; readonly record: SpoolRecord; readonly historyDomain: 'spool';
  readonly source: readonly SourceChainSliceR2[]; readonly provenanceDigest: Digest;
}
export function sourceSpoolDigest(record: Omit<SpoolRecord, 'digest'>): Digest { return streamDigest('spool-record', record); }
export function historySpoolDigest(record: Omit<SpoolRecord, 'digest'>): Digest { return streamDigest('spool', record); }
export function inputProvenanceDigest(input: Omit<CoalescedInputR2, 'provenanceDigest'>): Digest {
  return streamDigest('input-provenance-r2', input);
}

export interface AttachReceiptEntryR2 {
  readonly ordinal: number; readonly operationId: string; readonly commitId: string;
  readonly digest: Digest; readonly rows: number; readonly payloadBytes: number;
}
export interface AttachReceiptSetR2 {
  readonly revision: 2; readonly transactionId: string; readonly pane: PaneKey;
  readonly epoch: PipeEpoch; readonly decisionId: string; readonly expectedGeneration: number;
  readonly entries: readonly AttachReceiptEntryR2[]; readonly terminalCommitId: string;
  readonly aggregateDigest: Digest;
}
export function attachReceiptSetDigest(entries: readonly AttachReceiptEntryR2[]): Digest {
  return streamDigest('attach-receipt-set-r2', entries);
}
/** Structural conformance only. A MUST resolve every receipt through H's
 * read authority and compare staged transaction/epoch/decision before publish.
 * Bound entire set and return in order, never select one terminal/gap receipt. */
export function attachCoverage(set: AttachReceiptSetR2, receipts: readonly RowsAndGapsReceipt[]): Coverage {
  if (set.revision !== 2 || !set.transactionId || !set.decisionId || !sameContract(set.pane, set.epoch.pane)
    || set.entries.length === 0 || set.entries.length > FLAGON_REPAIR_LIMITS.receiptSetEntries
    || receipts.length !== set.entries.length || Buffer.byteLength(streamCanonical(set)) > MiB
    || Buffer.byteLength(streamCanonical(receipts)) > MiB) throw Error('attach manifest bound/identity');
  contractUint(set.expectedGeneration);
  if (set.aggregateDigest !== attachReceiptSetDigest(set.entries)) throw Error('attach aggregate digest');
  const ids = new Set<string>(), ops = new Set<string>();
  const coverage: Coverage[number][] = [];
  for (const [i, entry] of set.entries.entries()) {
    const receipt = receipts[i]!;
    contractUint(entry.rows); contractUint(entry.payloadBytes); contractHash(entry.digest);
    if (entry.ordinal !== i || entry.rows > 256 || entry.payloadBytes > MiB || !entry.commitId || !entry.operationId
      || ids.has(entry.commitId) || ops.has(entry.operationId) || receipt.kind !== 'rows-gaps-durable'
      || receipt.commitId !== entry.commitId || receipt.operationId !== entry.operationId
      || receipt.digest !== entry.digest || receipt.generation !== set.expectedGeneration) throw Error('attach receipt order/identity');
    ids.add(entry.commitId); ops.add(entry.operationId);
    let rows = 0;
    for (const part of receipt.coverage) {
      const pane = part.kind === 'rows' ? part.range.pane : part.gap.pane;
      if (!sameContract(pane, set.pane)) throw Error('attach cross-pane coverage');
      if (part.kind === 'rows') {
        contractUint(part.range.start); contractUint(part.range.end);
        if (part.range.end < part.range.start) throw Error('attach inverted coverage');
        rows += part.range.end - part.range.start;
      }
      coverage.push(part);
    }
    if (rows !== entry.rows) throw Error('attach row coverage');
  }
  if (set.terminalCommitId !== set.entries[set.entries.length - 1]!.commitId) throw Error('attach terminal receipt');
  return coverage;
}
export interface StagedRowsR2 extends RowsAndGapsCommit {
  readonly repair: { readonly revision: 2; readonly transactionId: string; readonly epoch: PipeEpoch;
    readonly decisionId: string; readonly chunkOrdinal: number; readonly visibility: 'candidate' };
}
export interface StagedReceiptR2 {
  readonly request: StagedRowsR2['repair']; readonly receipt: RowsAndGapsReceipt;
  readonly projection: CoverageProjectionR2;
}
export interface CommitAttachR2 extends Omit<CommitAttachRequest, 'durable'> {
  readonly receiptSet: AttachReceiptSetR2;
}
export interface AttachDecisionR2 extends AttachDecision {
  readonly revision: 2; readonly transactionId: string; readonly receiptSetDigest: Digest;
}

export interface ArchiveMemberMappingR2 {
  readonly sourcePath: string; readonly relativePath: string; readonly bytes: number; readonly sha256: Digest;
}
export interface ArchiveInventoryR2 {
  readonly revision: 2; readonly sealGeneration: number; readonly sealCommitId: string;
  readonly sealManifestSha256: Digest; readonly bundleManifestSha256: Digest;
  readonly members: readonly ArchiveMemberMappingR2[];
}
export function archiveInventoryMatches(seal: SealedExport, bundle: ArchiveBundle, inventory: ArchiveInventoryR2): boolean {
  return sameContract(seal.files, bundle.members);
  const sources = [...seal.files, seal.manifest];
  if (inventory.revision !== 2 || inventory.sealGeneration !== seal.generation || inventory.sealCommitId !== seal.sealCommitId
    || inventory.sealManifestSha256 !== seal.manifest.sha256 || inventory.bundleManifestSha256 !== bundle.manifest.sha256
    || bundle.storeUUID !== seal.storeUUID || bundle.segmentId !== seal.segmentId || !sameContract(bundle.pane, seal.pane)
    || !sameContract(bundle.coverage, seal.coverage) || sources.length !== inventory.members.length
    || bundle.members.length !== sources.length || sources.length > 256) return false;
  const usedSource = new Set<string>(), usedRelative = new Set<string>();
  for (const m of inventory.members) {
    if (!m.relativePath || m.relativePath.includes('\\') || m.relativePath.split('/').some(p => !p || p === '.' || p === '..')
      || /[\x00-\x1f\x7f:]/.test(m.relativePath) || usedSource.has(m.sourcePath) || usedRelative.has(m.relativePath)
      || !Number.isSafeInteger(m.bytes) || m.bytes < 0 || !/^[a-f0-9]{64}$/.test(m.sha256)) return false;
    usedSource.add(m.sourcePath); usedRelative.add(m.relativePath);
    const source = sources.find(f => f.path === m.sourcePath), member = bundle.members.find(f => f.path === m.relativePath);
    if (!source || !member || source.bytes !== m.bytes || member.bytes !== m.bytes || source.sha256 !== m.sha256 || member.sha256 !== m.sha256) return false;
  }
  return true;
}

export interface SegmentContinuityR2 {
  readonly revision: 2; readonly pane: PaneKey; readonly epoch: PipeEpoch;
  readonly predecessor: string; readonly successor: string; readonly boundary: RawPosition;
  readonly lastRow: SegmentRowId | null; readonly firstSuccessorOrdinal: 0;
  readonly sealCommitId: string; readonly rotationCommitId: string; readonly digest: Digest;
}
export function segmentContinuityDigest(value: Omit<SegmentContinuityR2, 'digest'>): Digest {
  return streamDigest('segment-continuity-r2', value);
}
export interface OrderedControlR2 {
  readonly revision: 2; readonly eventId: string; readonly position: RawPosition;
  /** Strictly increasing at the same raw offset; bytes after it use new state. */
  readonly order: number; readonly decoderVersion: string;
  readonly payload: { readonly kind: 'geometry'; readonly before: Geometry; readonly after: Geometry }
    | { readonly kind: 'control'; readonly name: string; readonly data: string };
  readonly digest: Digest;
}
export function orderedControlDigest(value: Omit<OrderedControlR2, 'digest'>): Digest {
  return streamDigest('ordered-control-r2', value);
}
export interface ReplayWatermarkR2 {
  readonly revision: 2; readonly pane: PaneKey; readonly checkpointId: string;
  readonly through: RawPosition; readonly controlOrder: number; readonly decoderVersion: string;
  readonly stateDigest: Digest; readonly known: Readonly<Record<string, boolean>>;
  readonly decisionIndexCommitId: string; readonly snapshotDependencies: readonly EvidenceFile[];
  readonly durableCommitId: string;
}
/** Persistent interval decisions, never regenerated from a resized decoder's
 * scroll ordinal. Keep metadata after payload reclaim; page it in <=256 items. */
export interface ReplayDecisionR2 {
  readonly decisionId: string; readonly raw: RawRange; readonly controlStart: number; readonly controlEnd: number;
  readonly disposition: 'consumed' | 'withheld'; readonly coverage: Coverage;
  readonly checkpointId: string; readonly decoderVersion: string;
}
export interface TimelineHeadR2 {
  readonly pane: PaneKey; readonly generation: number; readonly indexCommitId: string;
  readonly entryCount: number; readonly rowCount: number; readonly lastRow: SegmentRowId | null;
  readonly cursor: NewarchHistoryCursor;
}
export type TailAnchorR2 =
  | { readonly kind: 'genesis'; readonly birth: BirthCertificateR2 }
  | { readonly kind: 'local'; readonly head: TimelineHeadR2; readonly rows: readonly CommittedStreamRow[]; readonly pin: SegmentPin }
  | { readonly kind: 'blocked'; readonly head: TimelineHeadR2; readonly state: NewarchHistoryState };
export interface TimelinePageR2 {
  readonly head: TimelineHeadR2; readonly entries: readonly (CommittedStreamRow | Gap)[];
  readonly payloadBytes: number; readonly before: import('../../core/src/protocol').NewarchHistoryContinuation;
  readonly after: import('../../core/src/protocol').NewarchHistoryContinuation;
}
export interface BoundedReadR2 {
  readonly pane: PaneKey; readonly cursor: NewarchHistoryCursor | null;
  readonly direction: 'before' | 'after'; readonly maxEntries: number; readonly maxBytes: number;
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
  decisions(request: BoundedReadR2): Result<{ readonly entries: readonly ReplayDecisionR2[]; readonly next: NewarchHistoryCursor | null }>;
}
export interface ConsumerCheckpointR2 extends OperationFence {
  readonly revision: 2; readonly consumerId: string; readonly through: SpoolAck;
  readonly replayFloor: RawPosition; readonly watermark: ReplayWatermarkR2;
  readonly pins: readonly SegmentPin[];
  readonly recovery: { readonly kind: 'successor-checkpoint'; readonly checkpoint: ReplayWatermarkR2; readonly retentionCommitId: string }
    | { readonly kind: 'verified-archive'; readonly remote: RemoteIndexReceipt };
}
export interface TrimReceiptR2 {
  readonly revision: 2; readonly commitId: string; readonly epoch: PipeEpoch;
  readonly floor: RawPosition; readonly lastSequence: number; readonly lastDigest: Digest;
  readonly checkpoint: ConsumerCheckpointR2; readonly allocatedBytesBefore: number; readonly allocatedBytesAfter: number;
}
export type SpoolReadR2 =
  | { readonly kind: 'records'; readonly records: readonly SpoolRecord[]; readonly next: RawPosition; readonly atDurableHead: boolean }
  | { readonly kind: 'below-floor'; readonly requested: RawPosition; readonly retained: TrimReceiptR2 };
export interface CollectorArtifactR2 {
  readonly artifactSha256: Digest; readonly protocolVersion: number; readonly schemaVersion: number;
  readonly capabilities: readonly string[]; readonly runtimeProof: EvidenceFile;
}
export interface CollectorNegotiationR2 {
  readonly revision: 2; readonly binding: Binding; readonly running: CollectorArtifactR2;
  readonly allowed: readonly CollectorArtifactR2[];
}
/** Hash alone is insufficient. Candidate allowlist and live runtime identity
 * are checked by S/I; unknown required capabilities refuse before pipe change. */
export interface BirthCertificateR2 {
  readonly revision: 2; readonly creationId: string; readonly pane: PaneKey; readonly epoch: PipeEpoch;
  readonly command: 'new-session' | 'new-window' | 'split-window';
  readonly binarySha256: Digest; readonly hooksSha256: Digest;
  readonly transcript: EvidenceFile; readonly eventCoverage: EvidenceFile;
  readonly nonWaitingCommandEvents: readonly string[]; readonly rawStart: RawPosition;
  readonly genesis: VtCheckpoint;
}
export interface ReadyRetirementR2 extends OperationFence {
  readonly revision: 2; readonly binding: Binding; readonly attachId: string;
  readonly decision: AttachDecisionR2; readonly incident: import('../../core/src/protocol').NewarchIncidentR2;
}
export interface SourceTransportR2 extends SourceTransportPort {
  negotiate(request: CollectorNegotiationR2): Promise<Result<CollectorArtifactR2>>;
  acknowledgeConsumer(request: ConsumerCheckpointR2): Promise<Result<ConsumerCheckpointR2>>;
  trim(request: ConsumerCheckpointR2): Promise<Result<TrimReceiptR2>>;
  replayBounded(binding: Binding, after: RawPosition, maxRecords: number, maxBytes: number): Promise<Result<SpoolReadR2>>;
  retireReady(request: ReadyRetirementR2): Promise<Result<{ readonly commitId: string; readonly binding: Binding }>>;
  rearmReserve(request: OperationFence & { readonly incidentId: string; readonly resolvedCommitId: string }): Promise<Result<{ readonly commitId: string; readonly physicalFreeBytes: number }>>;
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
  rotateSegment(request: OperationFence & { readonly segmentId: string; readonly boundary: RawPosition }): Promise<Result<SegmentContinuityR2>>;
  /** Separate bounded scratch export from logical seal/rotation. */
  materializeExport(request: OperationFence & { readonly sealCommitId: string }): Promise<Result<SealedExport>>;
  journalControl(request: OperationFence & { readonly event: OrderedControlR2 }): Promise<Result<{ readonly commitId: string; readonly event: OrderedControlR2 }>>;
  commitReplayCheckpoint(request: OperationFence & { readonly checkpoint: VtCheckpoint; readonly watermark: ReplayWatermarkR2 }): Promise<Result<ReplayWatermarkR2>>;
  commitReplayDecision(request: OperationFence & { readonly decision: ReplayDecisionR2 }): Promise<Result<{ readonly commitId: string }>>;
}
export interface FrozenLegacyIntervalR2 extends OperationFence {
  readonly revision: 2; readonly intervalId: string; readonly from: FiniteCut; readonly cut: FiniteCut;
  readonly receipt: LegacyRangeReceipt; readonly readback: LegacyReadbackR2;
  readonly binding: WriterBinding; readonly suffix: SuffixPin; readonly freezeCommitId: string;
}
export interface SamePipeSwitchR2 extends OperationFence {
  readonly revision: 2; readonly switchId: string; readonly interval: FrozenLegacyIntervalR2;
  readonly binding: Binding; readonly to: 'newarch';
}
export interface SamePipeDecisionR2 {
  readonly revision: 2; readonly switchId: string; readonly commitId: string;
  readonly generation: number; readonly cut: FiniteCut; readonly binding: Binding;
}
export type PendingRecoveryR2 =
  | { readonly kind: 'none' }
  | { readonly kind: 'legacy-unverified-pending'; readonly sourceVersion: 1 | 2;
      readonly pendingId: string; readonly pane: PaneKey; readonly original: EvidenceFile;
      readonly readablePrefix: Coverage; readonly cursor: NewarchHistoryCursor }
  | { readonly kind: 'prepared'; readonly prepared: PreparedHandoff; readonly reason: 'unverified-receipt' | 'writer-unbound' | 'suffix-unpinned' | 'storage' }
  | { readonly kind: 'committed'; readonly decision: HandoffDecision }
  | { readonly kind: 'error'; readonly code: 'integrity' | 'io' | 'unsupported'; readonly message: string };
export interface RemoteAuthorizationR2 extends OperationFence {
  readonly revision: 2; readonly sealed: SealedExport; readonly inventory: ArchiveInventoryR2;
  readonly verified: VerifiedBundle;
}
export interface RemoteIndexR2 extends RemoteIndexReceipt {
  readonly repair: { readonly revision: 2; readonly sealCommitId: string; readonly sealGeneration: number;
    readonly inventoryDigest: Digest; readonly authorizationGeneration: number };
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
  commitHandoffR2(request: CommitHandoffRequest & { readonly readback: LegacyReadbackR2 }): Promise<Result<HandoffDecision>>;
  switchSamePipe(request: SamePipeSwitchR2): Promise<Result<SamePipeDecisionR2>>;
  commitRemoteIndex(request: RemoteAuthorizationR2): Promise<Result<RemoteIndexR2>>;
  resolveLegacyPending(request: OperationFence & { readonly pendingId: string; readonly handoff: CommitHandoffRequest; readonly readback: LegacyReadbackR2 }): Promise<Result<HandoffDecision>>;
}
export interface LegacyWriterR2 extends LegacyWriterPort {
  /** Must read actual durable commit/files/index/lines, independently of claim. */
  readback(receipt: LegacyRangeReceipt): Result<LegacyReadbackR2>;
  projection(commitId: string): Result<CoverageProjectionR2 | null>;
  freezeInterval(request: OperationFence & { readonly intervalId: string; readonly from: FiniteCut; readonly cut: FiniteCut; readonly binding: WriterBinding; readonly suffix: SuffixPin }): Promise<Result<FrozenLegacyIntervalR2>>;
  appendContinuous(request: ExactBatch & { readonly continuity: readonly SegmentContinuityR2[] }): Promise<Result<LegacyRangeReceipt>>;
}
export interface ArchiveBundleR2 extends ArchiveBundle {
  readonly repair: { readonly revision: 2; readonly inventory: ArchiveInventoryR2;
    readonly timelineIndex: EvidenceFile; readonly replayIndex: EvidenceFile };
}
export interface RestoreAuthorityR2 {
  lookup(range: SegmentRowRange): Result<SegmentLocation>;
  page(request: BoundedReadR2): Result<TimelinePageR2>;
  pin(request: PinRequest): Promise<Result<SegmentPin>>;
  release(pin: SegmentPin): Promise<Result<null>>;
}

export type GapR2 = import('../../core/src/protocol').NewarchGapR2;
/** Legacy identity is isolated in its own namespace; never add an r2 identity
 * to an old serialized gap or recalculate its durable digest during migration. */
export function gapIdentity(gap: Gap | GapR2): string {
  if ('repair' in gap) {
    if (gap.repair.revision !== 2 || !gap.repair.gapId) throw Error('unsupported gap identity');
    contractUint(gap.repair.sequence); contractUint(gap.repair.update);
    return streamCanonical(['gap-r2', gap.pane, gap.episodeId, gap.repair.gapId, gap.repair.sequence]);
  }
  return streamCanonical(['gap-v1', gap.pane, gap.episodeId]);
}
export function validGapUpdate(previous: GapR2, next: GapR2): boolean {
  return gapIdentity(previous) === gapIdentity(next) && previous.repair.state === 'open'
    && next.repair.update === previous.repair.update + 1
    && sameContract(previous.leftRowId, next.leftRowId) && previous.openedAt === next.openedAt
    && previous.clockEpoch === next.clockEpoch && next.withheldRows >= previous.withheldRows
    && (next.countKind !== 'unknown' || next.missingCount === null)
    && (next.repair.state === 'closed' ? next.closedAt !== null : next.closedAt === null);
}
export interface LogicalSealR2 {
  readonly revision: 2; readonly sealCommitId: string; readonly sealGeneration: number;
  readonly pane: PaneKey; readonly segmentId: string; readonly coverage: Coverage;
  readonly rawRanges: readonly RawRange[]; readonly checkpointIds: readonly string[];
  readonly timelineIndexCommitId: string; readonly replayIndexCommitId: string;
}
export interface FlagOnHistoryR2 {
  sealSegment(request: OperationFence & { readonly segmentId: string }): Promise<Result<LogicalSealR2>>;
  listSealed(cursor: string | null, limit: number): Result<{ readonly seals: readonly LogicalSealR2[]; readonly next: string | null }>;
  /** Verify remote via CatalogAuthorityR2 inside the transaction, together with
   * current generation and all pins; never trust the passed receipt alone. */
  reclaimR2(request: OperationFence & { readonly sealed: SealedExport; readonly remote: RemoteIndexR2; readonly inventory: ArchiveInventoryR2 }): Promise<Result<ReclaimReceipt>>;
}
export function archiveInventoryDigest(inventory: ArchiveInventoryR2): Digest {
  return streamDigest('archive-inventory-r2', inventory);
}

export interface HistoryAuthorityR2 {
  /** Present only after sealAttachSet verifies every staged chunk and prevents
   * further staging. A compares this durable manifest with its request. */
  attachSet(transactionId: string): Result<AttachReceiptSetR2 | null>;
}
export interface FlagOnHistoryR2 {
  sealAttachSet(request: OperationFence & { readonly manifest: AttachReceiptSetR2 }): Promise<Result<AttachReceiptSetR2>>;
}
export interface CatalogAuthorityR2 {
  switchDecision(switchId: string): Result<SamePipeDecisionR2 | null>;
}
export function sourceRecordsDigest(records: readonly SpoolRecord[]): Digest {
  return streamDigest('source-records-r2', records);
}
