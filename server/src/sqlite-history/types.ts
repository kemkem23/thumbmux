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
  frame?: FrameJournalRecordV1;
}
export interface LegacyProjectionAcknowledgement { requestId: string; digest: string }
export interface LegacyProjectionWriter {
  write(projection: LegacyProjection): Promise<LegacyProjectionAcknowledgement>;
}
export interface HistoryBridgeOptions extends HistoryCoordinatorOptions {
  spoolDirectory: string; legacyProjection: LegacyProjectionWriter;
}
export interface HistoryBridgeLedgerEntry {
  requestId: string; sessionId: string; digest: string;
  legacyCommitted: boolean; sqliteCommitted: boolean; sqliteRevision: number | null;
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

export interface HistoryCaptureCoordinator {
  start():void; probe(sessionId:string):Promise<CaptureReceipt>; stopAndDrain():Promise<void>;
}
