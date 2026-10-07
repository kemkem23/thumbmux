import { Database } from 'bun:sqlite';
import { type ProjectionRam, type SqlRow } from './ram-store.js';
import type { PaneKey, ProjectionArchiveReaderPort, ProjectionIssue, ProjectionLine, ProjectionPage, ProjectionToken } from './types.js';
/** Columns of one line inside a sealed block, in order; line_id is first_line_id+index. */
export declare const BLOCK_COLUMNS: readonly ["source_epoch", "revision", "geometry_generation", "text", "cells", "soft_wrap", "check_state", "check_reason", "checked_capture_id", "checked_row"];
/**
 * Durable lines [start,end) of one pane: sealed blocks first, then the per-line
 * tail. The writer keeps them disjoint (a line in a block is patched in place),
 * so a per-line row winning here only matters for a damaged file.
 */
export declare function readDiskLines(disk: Database, paneNo: number, start: number, end: number): SqlRow[];
/** A stored v4 line as the API line. */
export declare function projectionLine(r: SqlRow): ProjectionLine;
/** Overlay pending issue updates on their durable copies, just as for history rows. */
export declare function readProjectionIssues(ram: ProjectionRam, disk: Database, token: ProjectionToken): ProjectionIssue[];
export declare function projectionIssue(r: SqlRow): ProjectionIssue;
/** Where one pane's rows in a legacy file end and the current file's begin. */
export interface LegacyFloor {
    floor: number;
    reader: ProjectionArchiveReaderPort;
    token: ProjectionToken;
}
/**
 * Read-only history earlier releases wrote for the same panes, one file per
 * schema (PROJECTION_LEGACY_FILES). A pane first seen by the current writer
 * continues the legacy numbering, so ids [0,floor) are the legacy file's rows
 * and [floor,next) the current file's. Old history never keeps the current
 * writer from opening: a legacy file that cannot be read is reported in
 * `errors` and skipped.
 */
export declare class LegacyUnderlay {
    readonly errors: string[];
    private readonly readers;
    private readonly floors;
    constructor(files: readonly string[]);
    get size(): number;
    /** The pane in the first legacy file that holds it; a pane it cannot read counts as absent. */
    find(key: PaneKey): {
        reader: ProjectionArchiveReaderPort;
        token: ProjectionToken;
    } | null;
    /**
     * The pane's floor, or null. `lowest` is the smallest line id the current
     * file stores for the pane (its nextLineId when it stores none): the legacy
     * end at the moment the current writer first saw the pane, so the floor
     * survives a rollback that appended to the legacy file meanwhile (those
     * legacy rows at or above the floor stay in the legacy file only). A floor
     * the legacy file does not reach is not layered: the pane reads as before.
     */
    floor(key: PaneKey, lowest: () => number): LegacyFloor | null;
    close(): void;
}
/** Smallest line id a file stores for the pane, or null. */
export declare function lowestLine(db: Database, paneNo: number): number | null;
/**
 * One revision token spans disk pages and the RAM tail. A changed revision is a
 * retry. Below `underlay.floor` rows come from the legacy file: immutable, so
 * they are read at its own token and not held to this token's revision.
 */
export declare function readProjectionPage(ram: ProjectionRam, disk: Database, token: ProjectionToken, anchor: number | null, limit: number, underlay?: LegacyFloor | null): ProjectionPage;
/**
 * Read-only bridge for closed v2/v3/v4 archives and v5 files (including the live
 * v5 file of a running host). It never ATTACHes the archive to a live writer
 * and intentionally exposes rows/issues only: v2 capture/screen payloads are
 * legacy data, not a source for the current display. A version it does not
 * know is refused, never guessed. `legacyFiles` (v5 only) layers the files of
 * earlier releases under it exactly as the writer does (LegacyUnderlay): a pane
 * only they hold is read from them, and a pane that continues their numbering
 * reads [0,floor) from them.
 */
export declare function openProjectionArchive(input: string, legacyFiles?: readonly string[]): ProjectionArchiveReaderPort;
