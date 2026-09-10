import type { HistoryContext, HistoryFault, HistoryHealth, HistoryImportProgress, HistoryPageV1, HistoryRow, LegacyProjection, LegacyProjectionAcknowledgement, ShadowBatchSnapshot, ShadowComparisonReport, ShadowRuntimeState, ShadowSourceOracle } from './types';
/** Pure shadow comparator. The optional source oracle is independent of both
 * projections: legacy is never treated as the answer key for source completeness. */
export declare function compareShadowBatch(sessionId: string, legacy: ShadowBatchSnapshot, sqlite: ShadowBatchSnapshot, oracle: ShadowSourceOracle | null, comparedAt: number): ShadowComparisonReport;
/** Pure watchdog detector. Scheduling and alarm delivery remain host concerns. */
export declare function inspectShadowRuntime(state: ShadowRuntimeState, now: number, staleAfterMs?: number): HistoryFault[];
/** Call from a host watchdog/process independent of the collector event loop.
 * No internal timer: a frozen collector cannot freeze this caller's scheduling. */
export declare function inspectHistoryHealth(health: HistoryHealth, now?: number): HistoryFault[];
/** Transport independent viewer detector; no existing viewer is wired to this in wave 1. */
export declare function validateHistoryPage(context: HistoryContext, page: HistoryPageV1): void;
/** An independent original-record oracle must supply the expected occurrence list.
 * Sequential database allocation is deliberately irrelevant to this comparison. */
export declare function verifyHistoryOracle(expected: readonly HistoryRow[], observed: readonly HistoryRow[]): void;
export declare function inspectHistoryMirror(sessionId: string, targetRevision: number, exportedRevision: number, lagSince: number, now?: number): HistoryFault | null;
export declare function verifyDualWriteAcknowledgement(projection: LegacyProjection, acknowledgement: LegacyProjectionAcknowledgement): void;
/** The caller schedules this outside the importer event loop. A persisted checkpoint
 * timestamp makes a restarted watchdog able to distinguish progress from silence. */
export declare function inspectImportProgress(progress: HistoryImportProgress, now?: number): HistoryFault | null;
