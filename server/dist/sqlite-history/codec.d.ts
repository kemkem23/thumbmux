import type { CaptureObservation, HistoryRow, PhysicalRow, ProjectionCell } from './types';
export declare function safe(value: number, label?: string): number;
export declare function sha(value: string | Uint8Array): string;
export declare function rowsDigest(rows: readonly HistoryRow[]): string;
export declare function validateObservation(o: CaptureObservation): void;
type Cell = ProjectionCell;
/** Legacy (v2/v3) run-length JSON: one run per repeated identical cell. Kept for frames, fallback rows and v3 archives. */
export declare function encodeCellRuns(cells: readonly Cell[]): string;
export declare function decodeCellRuns(encoded: string | readonly unknown[]): Cell[];
/**
 * `text` and `cells` of a physical row → the stored pair. Compact when the text
 * is exactly the row's non-continuation graphemes (the runtime's rowText):
 *   cells = `<n>|<layout>|<runs>`, text = the row text without its trailing blank cells.
 * layout tokens (optional decimal count first): `a` one code point, width 1 ·
 * `w` one code point, width 2 · `c` continuation (''/0) · `(u,w,c)` anything else,
 * u = UTF-16 units taken from the text. Cells past the last token are `a`, and
 * `a` past the end of the stored text is ' ' (the trimmed blanks).
 * runs: space-separated `<count>` (default colours, style 0) or
 * `<count>:<fg>:<bg>:<style>`; cells past the last run are default.
 * Anything else (text that is not the cells, a continuation with a grapheme,
 * a colour outside the tokens) is stored verbatim with the legacy JSON runs.
 */
export declare function encodeRow(text: string, cells: readonly Cell[]): {
    text: string;
    cells: string;
};
/** The stored pair → the physical row, exactly as it was offered. */
export declare function decodeRow(stored: string, encoded: string): PhysicalRow;
/** Sealed history block: deflated JSON of consecutive stored lines of one pane. */
export declare const BLOCK_FORMAT = 1;
export declare function encodeBlock(lines: readonly unknown[][]): Uint8Array;
export declare function decodeBlock(data: Uint8Array): unknown[][];
export declare const CAPTURE_ARCHIVE_FORMAT = 1;
export declare function encodeCaptureArchive(rows: readonly unknown[][]): Uint8Array;
export declare function decodeCaptureArchive(data: Uint8Array): unknown[][];
/** Receipt metadata stays JSON, but the two 32-byte hashes stay binary. */
export declare function encodeCaptureReceipts(rows: readonly unknown[][]): Uint8Array;
export declare function decodeCaptureReceipts(data: Uint8Array): unknown[][];
export {};
