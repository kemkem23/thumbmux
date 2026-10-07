export declare const SNAP_BOTTOM_EVENTS = 24;
export declare const DEFAULT_WHEEL_MAX_PER_CALL = 6;
/** One or more SGR wheel events at cell (cx,cy), 1-based. up=64, down=65. */
export declare function sgrWheel(dir: 'up' | 'down', cx: number, cy: number, count?: number): string;
/** Press+release left click at cell (cx,cy). */
export declare function sgrClick(cx: number, cy: number): string;
/** Wheel-down burst that snaps an alt-screen TUI viewport back to the live tail. */
export declare function sgrSnapToBottom(cx: number, cy: number): string;
/**
 * Convert a browser wheel delta to terminal line movement.
 * Positive return values move up toward history; negative values move down.
 */
export declare function wheelEventToLines(deltaY: number, deltaMode: number, lineHeightPx: number, pageLines?: number): number;
/**
 * Return a safe conversation-area cell for synthetic pointer events.
 * Bottom composer regions in some full-screen TUIs ignore wheel events.
 */
export declare function centerContentCell(geom: {
    cols: number;
    rows: number;
}, opts?: {
    composerRows?: number;
}): {
    cx: number;
    cy: number;
};
/**
 * Map a pixel point inside a rendered pane box to a 1-based terminal cell.
 * Points on the right and bottom edges are inside and clamp to the last cell.
 */
export declare function contentCellFromPoint(clientX: number, clientY: number, rect: {
    left: number;
    top: number;
    width: number;
    height: number;
}, geom: {
    cols: number;
    rows: number;
}): {
    cx: number;
    cy: number;
    col0: number;
    row0: number;
} | null;
