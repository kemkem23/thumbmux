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
}

export interface HistoryCaptureCoordinator {
  start():void; probe(sessionId:string):Promise<CaptureReceipt>; stopAndDrain():Promise<void>;
}
