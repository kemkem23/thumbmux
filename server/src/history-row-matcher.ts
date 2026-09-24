/** Local L2-C ports; the integration lane adapts these to the L1 writer. */
export interface HistoryCell {
  grapheme: string;
  width: 0 | 1 | 2;
  continuation: boolean;
  fg: string;
  bg: string;
  style: number;
}
export interface HistoryRow {
  lineId: number;
  sourceEpoch: number;
  geometryGeneration: number;
  cells: readonly HistoryCell[];
  softWrap: boolean;
}
export interface CapturedRow {
  cells: readonly HistoryCell[];
  softWrap: boolean;
}
export function cellKey(cell: HistoryCell): string {
  return JSON.stringify([cell.grapheme, cell.width, cell.continuation, cell.fg, cell.bg, cell.style]);
}
export function rowKey(row: CapturedRow): string {
  return JSON.stringify([row.softWrap, row.cells.map(cellKey)]);
}
export interface RowMatch {
  checks: Array<{ lineId: number; capturedRow: number }>;
  repairs: Array<{ lineId: number; capturedRow: number; row: CapturedRow }>;
  reason: 'matched' | 'ambiguous' | 'partial-tail' | 'generation' | 'no-anchor';
}

// Z over interned exact row strings, not a hash-only comparison or edit distance.
function zValues(values: readonly (string | null)[]): number[] {
  const z = Array<number>(values.length).fill(0);
  let left = 0, right = 0;
  for (let i = 1; i < values.length; i++) {
    if (i <= right) z[i] = Math.min(right - i + 1, z[i - left]!);
    while (i + z[i]! < values.length && values[z[i]!] === values[i + z[i]!]) z[i]!++;
    if (i + z[i]! - 1 > right) { left = i; right = i + z[i]! - 1; }
  }
  return z;
}
function occurrences(pattern: string[], values: string[]): number {
  const z = zValues([...pattern, null, ...values]);
  let count = 0;
  for (let i = pattern.length + 1; i < z.length; i++) if (z[i]! >= pattern.length) count++;
  return count;
}
function triples(values: string[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (let i = 0; i + 2 < values.length; i++) {
    if (values[i] === values[i + 1] && values[i] === values[i + 2]) continue;
    const key = JSON.stringify(values.slice(i, i + 3));
    const positions = map.get(key) ?? [];
    positions.push(i); map.set(key, positions);
  }
  return map;
}

/** Only full retained captures certify uniqueness. A reduced tail is never a
 * substitute for evidence about the unseen ring, even if receiveSeq advanced. */
export function matchHistoryRows(
  recent: readonly HistoryRow[], captured: readonly CapturedRow[],
  scope: { sourceEpoch: number; geometryGeneration: number; completeRetainedTail: boolean },
): RowMatch {
  const empty = (reason: RowMatch['reason']): RowMatch => ({ checks: [], repairs: [], reason });
  if (!scope.completeRetainedTail) return empty('partial-tail');
  if (recent.some(r => r.sourceEpoch !== scope.sourceEpoch || r.geometryGeneration !== scope.geometryGeneration)) return empty('generation');
  const a = recent.map(rowKey), b = captured.map(rowKey);
  if (a.length < 3 || b.length < 3) return empty('no-anchor');
  const reversed = a.slice().reverse();
  const z = zValues([...reversed, null, ...b.slice().reverse()]);
  let length = 0, end = -1, count = 0;
  for (let i = 0; i < b.length; i++) {
    const n = z[a.length + 1 + i]!;
    if (n > length) { length = n; end = b.length - i; count = 1; }
    else if (n === length) count++;
  }
  if (length < 3) return empty('no-anchor');
  const anchor = a.slice(a.length - length);
  if (count !== 1 || new Set(anchor).size < 2 || occurrences(anchor, a) !== 1 || occurrences(anchor, b) !== 1) return empty('ambiguous');
  const result: RowMatch = { checks: [], repairs: [], reason: 'matched' };
  const offset = end - a.length;
  const checked = new Set<number>();
  const check = (i: number, j: number) => {
    if (!checked.has(i)) { result.checks.push({ lineId: recent[i]!.lineId, capturedRow: j }); checked.add(i); }
  };
  for (let i = a.length - length; i < a.length; i++) check(i, i + offset);

  // A mismatch can only be repaired between two independently unique triples
  // with identical row counts. No insertion/deletion or renumbering is inferred.
  const at = triples(a), bt = triples(b);
  const anchors: Array<[number, number]> = [];
  for (const [key, positions] of at) {
    const other = bt.get(key);
    if (positions.length === 1 && other?.length === 1 && other[0]! - positions[0]! === offset)
      anchors.push([positions[0]!, other[0]!]);
  }
  // Map iteration follows row order, so no O(n log n) sorting is needed.
  for (let k = 0; k < anchors.length; k++) {
    const [i, j] = anchors[k]!;
    for (let n = 0; n < 3; n++) check(i + n, j + n);
    const next = anchors[k + 1];
    if (!next || next[0] <= i + 3) continue;
    for (let x = i + 3; x < next[0]; x++) {
      const y = x + offset;
      if (a[x] === b[y]) check(x, y);
      else result.repairs.push({ lineId: recent[x]!.lineId, capturedRow: y, row: captured[y]! });
    }
  }
  return result;
}
