export const SNAP_BOTTOM_EVENTS = 24;
export const DEFAULT_WHEEL_MAX_PER_CALL = 6;

const WHEEL_UP_CODE = 64;
const WHEEL_DOWN_CODE = 65;
const DEFAULT_COMPOSER_ROWS = 8;
const DEFAULT_PAGE_LINES = 50;

function positiveCell(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function eventCount(count = 1): number {
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.floor(count));
}

function positiveFinite(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, value);
}

function positiveInteger(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const integer = Math.floor(value);
  return integer > 0 ? integer : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** One or more SGR wheel events at cell (cx,cy), 1-based. up=64, down=65. */
export function sgrWheel(dir: 'up' | 'down', cx: number, cy: number, count?: number): string {
  const code = dir === 'up' ? WHEEL_UP_CODE : WHEEL_DOWN_CODE;
  const x = positiveCell(cx);
  const y = positiveCell(cy);
  return `\x1b[<${code};${x};${y}M`.repeat(eventCount(count));
}

/** Press+release left click at cell (cx,cy). */
export function sgrClick(cx: number, cy: number): string {
  const x = positiveCell(cx);
  const y = positiveCell(cy);
  return `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`;
}

/** Wheel-down burst that snaps an alt-screen TUI viewport back to the live tail. */
export function sgrSnapToBottom(cx: number, cy: number): string {
  return sgrWheel('down', cx, cy, SNAP_BOTTOM_EVENTS);
}

/**
 * Convert a browser wheel delta to terminal line movement.
 * Positive return values move up toward history; negative values move down.
 */
export function wheelEventToLines(
  deltaY: number,
  deltaMode: number,
  lineHeightPx: number,
  pageLines = DEFAULT_PAGE_LINES,
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;

  let browserLines: number;
  if (deltaMode === 1) {
    browserLines = deltaY;
  } else if (deltaMode === 2) {
    browserLines = deltaY * positiveFinite(pageLines, DEFAULT_PAGE_LINES);
  } else {
    browserLines = deltaY / positiveFinite(lineHeightPx, 1);
  }

  return -browserLines;
}

/**
 * Return a safe conversation-area cell for synthetic pointer events.
 * Bottom composer regions in some full-screen TUIs ignore wheel events.
 */
export function centerContentCell(
  geom: { cols: number; rows: number },
  opts: { composerRows?: number } = {},
): { cx: number; cy: number } {
  const cols = Number.isFinite(geom.cols) ? Math.floor(geom.cols) : 0;
  const rows = Number.isFinite(geom.rows) ? Math.floor(geom.rows) : 0;
  const composerRows = typeof opts.composerRows === 'number' && Number.isFinite(opts.composerRows)
    ? Math.floor(opts.composerRows)
    : DEFAULT_COMPOSER_ROWS;

  const cx = Math.max(1, Math.floor(cols / 2));
  const cy = Math.max(1, Math.min(rows - composerRows, Math.floor(rows / 2)));
  return { cx, cy };
}

/**
 * Map a pixel point inside a rendered pane box to a 1-based terminal cell.
 * Points on the right and bottom edges are inside and clamp to the last cell.
 */
export function contentCellFromPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  geom: { cols: number; rows: number },
): { cx: number; cy: number; col0: number; row0: number } | null {
  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return null;
  }

  const cols = positiveInteger(geom.cols);
  const rows = positiveInteger(geom.rows);
  if (cols === null || rows === null) return null;

  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  if (
    !Number.isFinite(right) ||
    !Number.isFinite(bottom) ||
    clientX < rect.left ||
    clientX > right ||
    clientY < rect.top ||
    clientY > bottom
  ) {
    return null;
  }

  const col0 = clamp(Math.floor(((clientX - rect.left) / rect.width) * cols), 0, cols - 1);
  const row0 = clamp(Math.floor(((clientY - rect.top) / rect.height) * rows), 0, rows - 1);

  return {
    cx: col0 + 1,
    cy: row0 + 1,
    col0,
    row0,
  };
}
