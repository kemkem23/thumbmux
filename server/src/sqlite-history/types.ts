import type { FrameJournalRecordV1 } from '../frame-journal';
export type Continuity = 'verified' | 'unknown' | 'gap' | 'failed';
export interface HistoryContext {
  sessionId: string; revision: number; firstLine: number; liveStart: number; nextLine: number; continuity: Continuity;
}
export interface HistoryRow { line_no: number; kind: 'terminal' | 'gap'; text: string }
export interface HistoryGeometry {
  kind: 'pane' | 'legacy-window'; rows: number; cols: number; generation: number;
  alternate: boolean; cursor?: { row: number; col: number } | null;
}
export interface SourceObservation {
  // Polling snapshots cannot certify the interval before capture. No fabricated sequence.
  ringFull?: boolean; activity?: boolean; reset?: boolean;
}
export interface CaptureObservation {
  raw: string[]; screen: string[]; geometry: HistoryGeometry; at: number;
  source: SourceObservation;
}
export interface HistoryEvidence {
  classification: 'initial' | 'overlap' | 'missing' | 'ambiguous' | 'empty' | 'geometry' | 'import';
  depth: 'shallow' | 'deep' | 'import'; source: SourceObservation;
  rawSha256: string; requestDigest: string;
  importSpan?: { source_id: string; physicalRecordStart: number; count: number };
  legacy?: { liveStart: number; nextLine: number };
}
export interface HistoryFault {
  issue_id: string; sessionId: string; detector: string; expected: unknown; observed: unknown;
  timestamp: number; missing_count: number | null;
}
export interface SqliteHistoryOptions {
  file: string; onFault?: (fault: HistoryFault) => void;
}
export interface CaptureTicket { sessionId: string; lifecycleKey: string; fence: number; revision: number; requestId: string }
export interface CaptureBatch {
  ticket: CaptureTicket; observation: CaptureObservation; appended: Array<{ kind: 'terminal' | 'gap'; text: string }>;
  liveLineLimit: number; evidence: Omit<HistoryEvidence, 'requestDigest'>;
  recordFrames?: boolean; recordingSessionBytes?: number; recordingRootBytes?: number; unresolved?: Uint8Array; frame?: FrameJournalRecordV1;
}
export interface CaptureReceipt { context: HistoryContext; requestId: string; screen: string[]; geometry: HistoryGeometry; rowsSha256: string }
export interface HistoryPageV1 { context: HistoryContext; rows: HistoryRow[]; startLine: number; endLine: number; hasMore: boolean }
export interface HistoryHealth {
  sessionId: string; startedAt: number; lastProbeAt: number | null; lastCommitAt: number | null;
  continuity: Continuity; revision: number; fault: HistoryFault | null;
}
export interface HistoryCaptureDriver {
  geometryGeneration(sessionId: string): number;
  capture(sessionId: string, depth: 'shallow' | 'deep', signal: AbortSignal): Promise<CaptureObservation>;
}
export interface HistoryCoordinatorOptions {
  driver: HistoryCaptureDriver; sessions: () => string[]; liveLineLimit?: number;
  intervalMs?: number; deadlineMs?: number; recordFrames?: boolean; recordingSessionBytes?: number; recordingRootBytes?: number;
  publish?: (receipt: CaptureReceipt) => void | Promise<void>;
}
export type LegacyFormat = 'file-jsonl' | 'durable-log' | 'frame-ndjson' | 'host-chunks';
export interface HistoryImportOptions {
  sourceId: string; sessionId?: string; snapshotDirectory: string; format: LegacyFormat;
  onProgress?: (progress: HistoryImportProgress) => void;
}

export type HistoryImportState = 'pending' | 'copying' | 'verified' | 'quarantined';
export interface HistoryImportProgress {
  sourceId: string; sessionId: string | null; state: HistoryImportState;
  snapshotBytes: number; byteCursor: number; totalRecords: number; recordCursor: number;
  checkpointAt: number;
}
export interface ClosedHistoryImportOptions extends Omit<HistoryImportOptions, 'sessionId'> {
  name: string; lifecycleKey: string; group?: string;
}
export interface MigrationUnresolvedEntry {
  kind: 'import-state' | 'byte-cursor' | 'record-cursor' | 'source-error' | 'row-diff' | 'frame-diff' | 'screen-diff' | 'unresolved-capture';
  expected: number | string; observed: number | string;
}
export interface MigrationVerification {
  sourceId: string; sessionId: string;
  manifest: { files: number; bytes: number; sha256: string };
  rows: { expected: number; observed: number; sha256: string };
  frames: { expected: number; observed: number; sha256: string };
  screen: { expected: number; observed: number; sha256: string };
  unresolved: MigrationUnresolvedEntry[];
  ready: boolean;
}
export interface ClosedHistoryImportResult {
  sessionId: string; state: HistoryImportState; records: number;
  verification: MigrationVerification | null;
}

export interface LegacyProjection {
  requestId: string; sessionId: string;
  rows: Array<{ kind: 'terminal' | 'gap'; text: string }>;
  screen: string[]; raw: string[];
  geometry: HistoryGeometry; source: SourceObservation; at: number;
  frame?: FrameJournalRecordV1;
}
export interface ShadowFrameRecord { ordinal: number; bytes: string }
export interface ShadowUnresolvedRecord { ordinal: number; sha256: string }
export interface ShadowBatchSnapshot {
  requestId: string; revision: number; rows: HistoryRow[];
  frames: ShadowFrameRecord[]; unresolved: ShadowUnresolvedRecord[];
}
export interface ShadowSourceOracle {
  requestId: string; rows: HistoryRow[];
  frames?: ShadowFrameRecord[]; unresolved?: ShadowUnresolvedRecord[];
}
export interface ShadowComparisonReport {
  sessionId: string; requestId: string; comparedAt: number;
  receipts: { legacyRequestId: string; sqliteRequestId: string; match: boolean };
  lines: { matchedCoordinates: number; byteMismatches: number[]; kindMismatches: number[]; legacyOnly: number[]; sqliteOnly: number[] };
  frames: { matchedOrdinals: number; byteMismatches: number[]; legacyOnly: number[]; sqliteOnly: number[] };
  unresolved: { matchedOrdinals: number; digestMismatches: number[]; legacyOnly: number[]; sqliteOnly: number[] };
  source: {
    status: 'verified' | 'unknown' | 'mismatch';
    legacy: { missingCoordinates: number[]; extraCoordinates: number[]; byteMismatches: number[] } | null;
    sqlite: { missingCoordinates: number[]; extraCoordinates: number[]; byteMismatches: number[] } | null;
  };
  faults: HistoryFault[];
}
export interface LegacyProjectionAcknowledgement { requestId: string; digest: string; shadow?: ShadowBatchSnapshot }
export interface LegacyProjectionWriter {
  write(projection: LegacyProjection): Promise<LegacyProjectionAcknowledgement>;
}
export interface HistoryBridgeOptions extends HistoryCoordinatorOptions {
  spoolDirectory: string; legacyProjection: LegacyProjectionWriter;
}
export interface HistoryBridgeLedgerEntry {
  requestId: string; sessionId: string; digest: string;
  legacyCommitted: boolean; sqliteCommitted: boolean; sqliteRevision: number | null;
  shadowCompared?: boolean; shadowDelivered?: boolean;
}
export interface DualWriteReceipt {
  sqlite: CaptureReceipt; requestId: string; digest: string;
  legacyCommitted: true; sqliteCommitted: true;
}
export interface HistoryCaptureBridge {
  start(): void; probe(sessionId: string): Promise<DualWriteReceipt>;
  resumePending(): Promise<HistoryBridgeLedgerEntry[]>;
  ledger(): HistoryBridgeLedgerEntry[];
  stopAndDrain(): Promise<void>;
}

export interface HistoryShadowBridgeOptions extends HistoryBridgeOptions {
  shadow: {
    sourceOracle: (projection: LegacyProjection) => ShadowSourceOracle | null;
    onComparison: (report: ShadowComparisonReport) => void | Promise<void>;
    now?: () => number;
  };
}
export interface ShadowRuntimeState {
  sessionId: string; startedAt: number; lastProbeAt: number | null; inFlightSince: number | null;
  targetRevision: number; exportedRevision: number; exportLagSince: number | null;
  lastWriteFailure: { backend: 'legacy' | 'sqlite'; at: number; error: string } | null;
}

export interface HistoryCaptureCoordinator {
  start():void; probe(sessionId:string):Promise<CaptureReceipt>; stopAndDrain():Promise<void>;
}

// newarch-frame-v1: opt-in projection contract; v1 callers retain their types.
export interface PaneKey { serverIdentity: string; paneId: string; birthGeneration: number }
export interface ProjectionCell {
  grapheme: string; width: number; continuation: boolean;
  fg: string | number | null; bg: string | number | null; style: number;
}
export interface PhysicalRow { text: string; cells: ProjectionCell[] }
export interface ScrollEvent {
  paneKey: PaneKey; sourceEpoch: number; geometryGeneration: number;
  physicalRow: PhysicalRow; softWrap: boolean; receiveSeq: number;
}
export interface ProjectionFrame {
  paneKey: PaneKey; sourceEpoch: number; geometryGeneration: number; receiveSeq: number;
  cells: ProjectionCell[][]; cursor: { row: number; col: number; visible: boolean } | null;
  kind: 'normal' | 'alternate'; cols: number; rows: number;
}
export interface ProjectionCapture extends ProjectionFrame {
  captureId: string; requestedAt: number; completedAt: number;
  firstHistoryRow: number; history: PhysicalRow[]; observedFields: string[];
  ambiguousRows: number; result: string;
}
export type CaptureEvidence =
  | { kind: 'byte-fence'; sourceEpoch: number; receiveSeq: number }
  | { kind: 'unfenced'; reason: string };
export interface ProjectionIssueInput {
  paneKey: PaneKey; sourceEpoch: number; geometryGeneration: number;
  expectedRevision: number; kind: string; reason: string; missingCount: number | null;
  boundaryLineId: number; recoverable: boolean;
}
export interface ProjectionIssue {
  issueId: string; sourceEpoch: number; revision: number; boundaryLineId: number | null;
  kind: string; reason: string; missingCount: number | null; detectedAt: number; resolvedAt: number | null;
}
export interface ProjectionEpochTransition extends ProjectionIssueInput { nextEpoch: number }
export interface ProjectionCalibration {
  capture: ProjectionCapture; expectedRevision: number;
  captureEvidence?: CaptureEvidence;
  checks: Array<{ lineId: number; captureRow: number }>;
  repairs: Array<{ lineId: number; captureRow: number; physicalRow: PhysicalRow }>;
}
export interface ProjectionReceipt { revision: number; durableRevision: number; nextLineId: number }
export interface ProjectionToken extends ProjectionReceipt {
  paneKey: PaneKey; sourceEpoch: number; geometryGeneration: number;
}
export interface ProjectionLine extends PhysicalRow {
  lineId: number; sourceEpoch: number; geometryGeneration: number; revision: number; softWrap: boolean;
  checkState: 'unchecked' | 'checked'; checkReason: string;
  checkedCaptureId: string | null; checkedRow: number | null;
}
export interface ProjectionPage {
  token: ProjectionToken; lines: ProjectionLine[]; issues: ProjectionIssue[]; nextAnchor: number; hasMore: boolean;
}
export interface ProjectionFault {
  kind: string; at: number; reason: string; pendingBytes: number;
  panes?: Array<{ paneKey: PaneKey; sourceEpoch: number; boundaryLineId: number; missingCount: number | null }>;
}
export interface ProjectionHealth {
  status: 'healthy' | 'degraded' | 'stopped'; pendingBytes: number; pendingAgeMs: number; rejectedRows: number;
  ramBytes: number; rssBytes: number; lastFlushAgeMs: number; lastCommitAt: number | null;
  pressure: 'none' | 'recoverable';
  panes: Array<ProjectionToken & { status: 'healthy' | 'degraded'; issues: ProjectionIssue[] }>;
}
export interface ProjectionWriterPort {
  recordIssue(issue: ProjectionIssueInput): Promise<ProjectionReceipt>;
  transitionEpoch(change: ProjectionEpochTransition): Promise<ProjectionReceipt>;
  appendScroll(event: ScrollEvent): Promise<ProjectionReceipt>;
  replaceScreen(frame: ProjectionFrame): Promise<ProjectionReceipt>;
  calibrate(change: ProjectionCalibration): Promise<ProjectionReceipt>;
  readPage(token: ProjectionToken, anchor: number | null, limit: number): ProjectionPage;
  flush(): void; health(): ProjectionHealth;
}
