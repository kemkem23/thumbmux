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

/** Hash buckets are only an accelerator: exact cell comparison assigns IDs.
 * Nothing is cached across calls, so mutable caller rows cannot retain stale keys. */
export function equalHistoryRows(a: CapturedRow, b: CapturedRow): boolean {
  if (a.softWrap !== b.softWrap || a.cells.length !== b.cells.length) return false;
  if (a.cells === b.cells) return true;
  for (let x = 0; x < a.cells.length; x++) {
    const c = a.cells[x]!, d = b.cells[x]!;
    if (c.grapheme !== d.grapheme || c.width !== d.width || c.continuation !== d.continuation
      || c.fg !== d.fg || c.bg !== d.bg || c.style !== d.style) return false;
  }
  return true;
}
function internRows(rows: readonly (readonly CapturedRow[])[]): number[][] {
  const buckets = new Map<number, Array<{ row: CapturedRow; id: number }>>();
  let id = 0;
  return rows.map(part => part.map(row => {
    // Sample glyphs to keep keys small. A bucket collision is resolved exactly.
    let key = row.cells.length ^ (row.softWrap ? 0x40000000 : 0);
    for (let x = 0; x < Math.min(16, row.cells.length); x++) {
      const glyph = row.cells[x]!.grapheme;
      for (let c = 0; c < glyph.length; c++) key = Math.imul(key ^ glyph.charCodeAt(c), 16777619);
      key = Math.imul(key ^ 0xff, 16777619);
    }
    const bucket = buckets.get(key);
    const found = bucket?.find(entry => equalHistoryRows(entry.row, row));
    if (found) return found.id;
    const entry = { row, id: ++id };
    if (bucket) bucket.push(entry); else buckets.set(key, [entry]);
    return entry.id;
  }));
}
// Z over exact row IDs; triples contain three integers instead of three full rows.
function zValues(values: readonly (number | null)[]): number[] {
  const z = Array<number>(values.length).fill(0);
  let left = 0, right = 0;
  for (let i = 1; i < values.length; i++) {
    if (i <= right) z[i] = Math.min(right - i + 1, z[i - left]!);
    while (i + z[i]! < values.length && values[z[i]!] === values[i + z[i]!]) z[i]!++;
    if (i + z[i]! - 1 > right) { left = i; right = i + z[i]! - 1; }
  }
  return z;
}
function occurrences(pattern: number[], values: number[]): number {
  const z = zValues([...pattern, null, ...values]);
  let count = 0;
  for (let i = pattern.length + 1; i < z.length; i++) if (z[i]! >= pattern.length) count++;
  return count;
}
function triples(values: number[], base: number): Map<number | string, number[]> {
  const map = new Map<number | string, number[]>();
  for (let i = 0; i + 2 < values.length; i++) {
    if (values[i] === values[i + 1] && values[i] === values[i + 2]) continue;
    const key = base < 200000 ? (values[i]! * base + values[i + 1]!) * base + values[i + 2]!
      : `${values[i]},${values[i + 1]},${values[i + 2]}`;
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
  if (recent.length >= 3 && recent.length === captured.length) {
    // Common steady state: aligned rings with at most one cell-drift row.
    // Scan exact cells once; avoid constructing 9,000 row/triple entries.
    let mismatch = -1, differences = 0;
    for (let i = 0; i < recent.length; i++) {
      if (!equalHistoryRows(recent[i]!, captured[i]!)) { mismatch = i; if (++differences > 1) break; }
    }
    const uniqueTriple = (start: number, rows: readonly CapturedRow[]) => {
      const pattern = recent.slice(start, start + 3);
      if (equalHistoryRows(pattern[0]!, pattern[1]!) && equalHistoryRows(pattern[0]!, pattern[2]!)) return false;
      // Pick a discriminating glyph once, avoiding full scans of candidates
      // whose ordinary row labels differ only near the end of their prefix.
      let probe = 0;
      for (let x = 0; x < pattern[0]!.cells.length; x++) {
        if (pattern[0]!.cells[x]!.grapheme !== pattern[1]!.cells[x]?.grapheme
          || pattern[0]!.cells[x]!.grapheme !== pattern[2]!.cells[x]?.grapheme) { probe = x; break; }
      }
      const glyph = pattern[0]!.cells[probe]?.grapheme;
      let hits = 0;
      for (let i = 0; i + 2 < rows.length; i++) {
        if (rows[i]!.cells[probe]?.grapheme !== glyph) continue;
        if (equalHistoryRows(pattern[0]!, rows[i]!) && equalHistoryRows(pattern[1]!, rows[i + 1]!)
          && equalHistoryRows(pattern[2]!, rows[i + 2]!) && ++hits > 1) return false;
      }
      return hits === 1;
    };
    if (differences === 0) {
      if (recent.every(row => equalHistoryRows(row, recent[0]!))) return empty('ambiguous');
      return { reason: 'matched', repairs: [], checks: recent.map((row, i) => ({ lineId: row.lineId, capturedRow: i })) };
    }
    if (differences === 1 && mismatch >= 3 && mismatch + 3 < recent.length
      && [mismatch - 3, mismatch + 1].every(start => uniqueTriple(start, recent) && uniqueTriple(start, captured))) {
      const checks: RowMatch['checks'] = [];
      for (let i = 0; i < recent.length; i++) if (i !== mismatch) checks.push({ lineId: recent[i]!.lineId, capturedRow: i });
      return { reason: 'matched', checks,
        repairs: [{ lineId: recent[mismatch]!.lineId, capturedRow: mismatch, row: captured[mismatch]! }] };
    }
  }
  const [a, b] = internRows([recent, captured]) as [number[], number[]];
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

  if (length === a.length) return result;

  // A mismatch can only be repaired between two independently unique triples
  // with identical row counts. No insertion/deletion or renumbering is inferred.
  const base = a.length + b.length + 1;
  const at = triples(a, base), bt = triples(b, base);
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

/** A committed full capture seeds this chain. Partial captures must overlap a
 * previously checked, still exact, unique triple. Never infer across a gap.
 * The host must reset on every clear/resize/epoch transition and only remember
 * successful transactions. Receipts certify observed content, not hidden IDs. */
export class IncrementalHistoryMatcher {
  private checked = new Map<number, CapturedRow>();
  private generation = '';
  reset(): void { this.checked.clear(); }
  match(recent: readonly HistoryRow[], captured: readonly CapturedRow[], scope: Parameters<typeof matchHistoryRows>[2]): RowMatch {
    const generation = `${scope.sourceEpoch}/${scope.geometryGeneration}`;
    if (this.generation !== generation) { this.reset(); this.generation = generation; }
    if (scope.completeRetainedTail) return matchHistoryRows(recent, captured, scope);
    const empty = (reason: RowMatch['reason']): RowMatch => ({ checks: [], repairs: [], reason });
    if (recent.some(r => r.sourceEpoch !== scope.sourceEpoch || r.geometryGeneration !== scope.geometryGeneration)) return empty('generation');
    const prior = [...this.checked.entries()];
    if (prior.length !== 3) return empty('partial-tail');
    const first = recent.findIndex(row => row.lineId === prior[0]![0]);
    if (first < 0 || prior.some(([id, row], n) => recent[first + n]?.lineId !== id || !equalHistoryRows(row, recent[first + n]!))) return empty('partial-tail');
    const locate = (rows: readonly CapturedRow[], pattern: readonly CapturedRow[]): number => {
      if (equalHistoryRows(pattern[0]!, pattern[1]!) && equalHistoryRows(pattern[0]!, pattern[2]!)) return -1;
      let probe = 0;
      for (let x = 0; x < pattern[0]!.cells.length; x++) {
        if (pattern[0]!.cells[x]!.grapheme !== pattern[1]!.cells[x]?.grapheme
          || pattern[0]!.cells[x]!.grapheme !== pattern[2]!.cells[x]?.grapheme) { probe = x; break; }
      }
      const glyph = pattern[0]!.cells[probe]?.grapheme;
      let found = -1;
      for (let i = 0; i + 2 < rows.length; i++) {
        if (rows[i]!.cells[probe]?.grapheme !== glyph) continue;
        if (equalHistoryRows(rows[i]!, pattern[0]!) && equalHistoryRows(rows[i + 1]!, pattern[1]!) && equalHistoryRows(rows[i + 2]!, pattern[2]!)) {
          if (found >= 0) return -1;
          found = i;
        }
      }
      return found;
    };
    const pattern = prior.map(([, row]) => row);
    const at = locate(captured, pattern);
    if (at < 0 || locate(recent, pattern) !== first) return empty('ambiguous');
    const offset = at - first;
    const result = empty('matched');
    // Scan only the captured overlap. The saved triple certifies its exact run;
    // runs beyond changed rows need their own globally unique triple. No repair
    // or inferred index shift is ever made by an incremental capture.
    let i = Math.max(0, -offset);
    while (i < recent.length && i + offset < captured.length) {
      if (!equalHistoryRows(recent[i]!, captured[i + offset]!)) { i++; continue; }
      const start = i;
      while (i < recent.length && i + offset < captured.length && equalHistoryRows(recent[i]!, captured[i + offset]!)) i++;
      let anchored = start <= first && i >= first + 3;
      for (let k = start; !anchored && k + 2 < i; k++) {
        const triple = recent.slice(k, k + 3);
        anchored = locate(recent, triple) === k && locate(captured, triple) === k + offset;
      }
      if (anchored) for (let k = start; k < i; k++) result.checks.push({ lineId: recent[k]!.lineId, capturedRow: k + offset });
    }
    if (at + 3 < captured.length && !result.checks.some(check => check.capturedRow >= at + 3)) result.reason = 'ambiguous';
    return result;
  }
  remember(recent: readonly HistoryRow[], captured: readonly CapturedRow[], match: RowMatch): void {
    // Only the terminal verified triple is needed to seed the next chain.
    // Copying 128 full rows on every 200ms tick dominated collector work.
    this.checked.clear();
    for (const check of match.checks.slice(-3)) this.checked.set(check.lineId, structuredClone(captured[check.capturedRow]!));
  }
}
