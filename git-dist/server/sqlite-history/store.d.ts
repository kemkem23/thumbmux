import type { Database } from 'bun:sqlite';
import type { CaptureBatch, CaptureReceipt, CaptureTicket, HistoryContext, HistoryFault, HistoryHealth, HistoryPageV1, HistoryRow, ShadowBatchSnapshot, SqliteHistoryOptions } from './types.js';
type Session = {
    session_id: string;
    lifecycle_key: string;
    name: string;
    group_label: string;
    active: number;
    writer_fence: number;
    revision: number;
    first_line: number;
    next_line: number;
    live_start: number;
    last_probe_at: number | null;
    last_commit_at: number | null;
    continuity: HistoryContext['continuity'];
};
type Capture = {
    seq: number;
    request_id: string;
    previous_seq: number;
    at: number;
    geometry_json: string;
    screen_json: string;
    row_start: number;
    row_end: number;
    first_line: number;
    live_start: number;
    next_line: number;
    expected_rows: number;
    rows_sha256: string;
    evidence_json: string;
    unresolved_capture: Uint8Array | null;
};
/** Internal implementation. SQL handle is never exposed by the public facade. */
export declare class HistoryStore {
    readonly db: Database;
    private options;
    private closed;
    private fence;
    private chain;
    private faults;
    private startedAt;
    private listeners;
    constructor(db: Database, options: SqliteHistoryOptions);
    get file(): string;
    pragma(name: string): number;
    checkOwner(): void;
    session(sid: string): Session;
    context(s: Session): HistoryContext;
    report(sid: string, detector: string, expected: unknown, observed: unknown, missing?: number | null): HistoryFault;
    issue(fault: HistoryFault, seq?: number | null): void;
    persistFault(sid: string, detector: string, expected: unknown, observed: unknown): HistoryFault;
    write<T>(sid: string, operation: () => T): Promise<T>;
    register(input: {
        name: string;
        lifecycleKey: string;
        group?: string;
        firstLine?: number;
    }): Promise<string>;
    ticket(sid: string, requestId?: string): CaptureTicket;
    capture(sid: string, seq: number): Capture;
    receipt(sid: string, c: Capture): CaptureReceipt;
    rows(sid: string, start: number, end: number): HistoryRow[];
    shadowSnapshot(sid: string, requestId: string): ShadowBatchSnapshot;
    tail(sid: string, count?: number): HistoryRow[];
    commit(batch: CaptureBatch, checkpoint?: () => void): Promise<CaptureReceipt>;
    insertFrame(sid: string, input: import('../frame-journal.js').FrameJournalRecordV1, captureSeq: number | null): void;
    rename(sid: string, name: string, group?: string): Promise<void>;
    closeSession(sid: string): Promise<void>;
    snapshot(sid: string): CaptureReceipt & {
        live: HistoryRow[];
    };
    checkRange(sid: string, rows: HistoryRow[], start: number, end: number): void;
    page(sid: string, direction: 'before' | 'after', anchor: number | null, limit: number, context?: HistoryContext): HistoryPageV1;
    audit(sid: string, afterSeq?: number): {
        captures: number;
        rows: number;
    };
    health(sid: string): HistoryHealth;
    addDrain(drain: () => Promise<void>): void;
    close(): Promise<void>;
}
export declare function prepareFile(file: string): string;
export {};
