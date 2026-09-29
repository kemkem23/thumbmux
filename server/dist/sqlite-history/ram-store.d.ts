import { Database } from 'bun:sqlite';
import type { PaneKey, PhysicalRow, ProjectionCalibration, ProjectionIssueInput, ProjectionFrame, ProjectionReceipt, ProjectionToken, ScrollEvent } from './types';
export declare const EVICT_LINES_SQL = "DELETE FROM na_line WHERE pane_no=? AND line_id<? AND revision<=?";
export type SqlRow = Record<string, string | number | null>;
export declare const paneId: (key: PaneKey) => string;
export declare function integer(n: number): number;
export declare function validateRow(row: PhysicalRow): void;
/** Legacy run-length JSON (frames in RAM, rows the compact codec cannot express, v2/v3 archives). */
export declare function encodeCells(cells: PhysicalRow['cells']): string;
export declare function decodeCells(encoded: string): PhysicalRow['cells'];
/** Stored line (text + compact cells) → the physical row as offered. */
export declare function lineRow(row: SqlRow): PhysicalRow;
export declare const checkState: (code: unknown) => "unchecked" | "checked" | "content-matched";
export declare const checkReason: (code: unknown) => "awaiting-capture" | "evicted-before-check" | "exact-capture" | "content-capture";
export declare function encodeObservedFields(fields: readonly string[]): number | string;
export declare function decodeObservedFields(value: number | string): string[];
export declare function encodeFrameCells(cells: PhysicalRow['cells'][]): string;
export declare function decodeFrameCells(encoded: string): PhysicalRow['cells'][];
export declare function validateFrame(frame: ProjectionFrame): void;
/** Hold each statement for the lifetime of its DB, independently of Bun's 20-entry query cache. */
export declare function prepared(db: Database, sql: string): ReturnType<Database['query']>;
/** Explicitly finalize the statements held outside Bun's query cache before closing SQLite. */
export declare function closePrepared(db: Database): void;
export declare function upsert(db: Database, table: string, row: SqlRow): void;
/** Only the bounded live working set lives here. Disk history is never loaded wholesale. */
export declare class ProjectionRam {
    readonly db: Database;
    private readonly pageSize;
    constructor();
    pane(key: PaneKey): SqlRow;
    paneNo(key: PaneKey): number;
    token(key: PaneKey): ProjectionToken;
    /**
     * First line id of a pane this store has never seen. The store continues the
     * numbering of a pane an earlier release recorded (its legacy nextLineId), so
     * one id names one row across both files. Default 0.
     */
    firstLineId: (key: PaneKey) => number;
    ensure(key: PaneKey, epoch: number, geometry: number): SqlRow;
    bump(key: PaneKey): ProjectionReceipt;
    /** `stored`: the row already encoded by the caller (codec.ts encodeRow). */
    append(event: ScrollEvent, stored?: {
        text: string;
        cells: string;
    }): ProjectionReceipt;
    /** `uncertain`: capture rows drawn but not certified (D18); a pipe frame always clears them. */
    screen(frame: ProjectionFrame, captureId?: string | null, at?: number | null, observed?: string[], preparedCells?: string, uncertain?: readonly number[]): void;
    /** Revision the caller's CAS is compared with; a pane not yet seen is revision 0. */
    revisionOf(key: PaneKey): number;
    /**
     * `casAtAdmission`: the store already compared expectedRevision when it
     * admitted the job (F12); jobs admitted earlier for the same pane then run
     * first by queue order, so the run-time revision is no longer the caller's.
     */
    recordIssue(issue: ProjectionIssueInput, nextEpoch?: number, casAtAdmission?: boolean): ProjectionReceipt;
    /**
     * `historyOnly` (M2): without screen evidence nothing on screen is replaced,
     * and every checked or repaired history row is compared byte for byte below,
     * so rows and frames that arrived after the caller's read cannot make it
     * wrong. Only a revision the pane never had (from the future) is refused.
     */
    calibrate(change: ProjectionCalibration, historyOnly?: boolean): ProjectionReceipt;
    /** Live pages only: eviction returns pages to the freelist, which page_count still counts (F13). */
    bytes(): number;
    evict(panes: SqlRow[], keep?: number): void;
}
