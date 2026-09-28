import { Database } from 'bun:sqlite';
import { type ProjectionRam, type SqlRow } from './ram-store.js';
import type { ProjectionArchiveReaderPort, ProjectionIssue, ProjectionLine, ProjectionPage, ProjectionToken } from './types.js';
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
/** One revision token spans disk pages and the RAM tail. A changed revision is a retry. */
export declare function readProjectionPage(ram: ProjectionRam, disk: Database, token: ProjectionToken, anchor: number | null, limit: number): ProjectionPage;
/**
 * Read-only bridge for closed v2/v3 archives and v4 files (including the live
 * v4 file of a running host). It never ATTACHes the archive to a live writer
 * and intentionally exposes rows/issues only: v2 capture/screen payloads are
 * legacy data, not a source for the current display. A version it does not
 * know is refused, never guessed.
 */
export declare function openProjectionArchive(input: string): ProjectionArchiveReaderPort;
