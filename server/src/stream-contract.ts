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
