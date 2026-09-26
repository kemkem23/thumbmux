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
  /** Rows inside a triple that is unique and aligned in both the parser ring
   * and the capture. Only these carry an identity claim (D16 identityFalse). */
  checks: Array<{ lineId: number; capturedRow: number }>;
  /** Rows whose cells equal the aligned capture row but that no unique triple
   * covers (blank runs, repeated prompts). Content is proven, hidden identity
   * is not: FIX1-PLAN §2 `content-matched`, measured by contentFalse only. */
  contentMatches: Array<{ lineId: number; capturedRow: number }>;
  repairs: Array<{ lineId: number; capturedRow: number; row: CapturedRow }>;
  reason: 'matched' | 'ambiguous' | 'partial-tail' | 'generation' | 'no-anchor';
}
export type MatchScope = {
  sourceEpoch: number; geometryGeneration: number; completeRetainedTail: boolean; maxTailGap?: number;
  /** Captured rows whose cell boundaries tmux does not serialize exactly
   * (decoder row isolation). They never equal anything, so they are neither
   * checked, content-matched, nor part of an anchor. */
  uncertainCapturedRows?: ReadonlySet<number>;
};

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
/** equalHistoryRows, comparing outward from `probe` first. Candidates in a
 * locate scan already share the probe glyph and usually differ in the cell
 * beside it (row counters), not in the shared prefix. Same result, fewer reads. */
function equalRowsAround(a: CapturedRow, b: CapturedRow, probe: number): boolean {
  if (a.softWrap !== b.softWrap || a.cells.length !== b.cells.length) return false;
  if (a.cells === b.cells) return true;
  const same = (x: number) => {
    const c = a.cells[x]!, d = b.cells[x]!;
    return c.grapheme === d.grapheme && c.width === d.width && c.continuation === d.continuation
      && c.fg === d.fg && c.bg === d.bg && c.style === d.style;
  };
  const start = Math.min(probe, a.cells.length - 1);
  for (let x = start; x >= 0; x--) if (!same(x)) return false;
  for (let x = start + 1; x < a.cells.length; x++) if (!same(x)) return false;
  return true;
}
/** Sampled glyph key: first 16 glyphs, every 8th after, and the last. Equal
 * rows always share it; different rows may too and are resolved exactly. */
function rowSampleKey(row: CapturedRow): number {
  const cells = row.cells;
  let key = cells.length ^ (row.softWrap ? 0x40000000 : 0);
  const mix = (x: number) => {
    const glyph = cells[x]!.grapheme;
    for (let c = 0; c < glyph.length; c++) key = Math.imul(key ^ glyph.charCodeAt(c), 16777619);
    key = Math.imul(key ^ 0xff, 16777619);
  };
  const head = Math.min(16, cells.length);
  for (let x = 0; x < head; x++) mix(x);
  for (let x = head + 7; x < cells.length - 1; x += 8) mix(x);
  if (cells.length > head) mix(cells.length - 1);
  return key;
}
function internRows(rows: readonly (readonly CapturedRow[])[], uncertain?: ReadonlySet<number>): number[][] {
  const buckets = new Map<number, Array<{ row: CapturedRow; id: number }>>();
  let id = 0;
  return rows.map((part, p) => part.map((row, y) => {
    // An uncertain captured row gets a private ID: it equals nothing.
    if (p === 1 && uncertain?.has(y)) return ++id;
    const key = rowSampleKey(row);
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
function tripleCounts(values: readonly number[], base: number): Map<number | string, number> {
  const counts = new Map<number | string, number>();
  for (let i = 0; i + 2 < values.length; i++) {
    if (values[i] === values[i + 1] && values[i] === values[i + 2]) continue;
    const key = tripleKey(values, i, base);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
function tripleKey(values: readonly number[], i: number, base: number): number | string {
  return base < 200000 ? (values[i]! * base + values[i + 1]!) * base + values[i + 2]!
    : `${values[i]},${values[i + 1]},${values[i + 2]}`;
}
/** FIX1-PLAN §2 checked rows. Inside one run of rows equal at the offset, a
 * row is checked only when (1) a unique-in-both triple starts above it and a
 * different one ends below it, so two independent anchors fix the offset on
 * both sides, and (2) its content differs from both neighbours: a dropped and
 * a duplicated row inside a run of identical text keep every cell equal while
 * shifting hidden identities. Every other equal row is content-matched. */
function classify(from: number, to: number, equal: (i: number) => boolean, sameAsNext: (i: number) => boolean,
  unique: (i: number) => boolean): Uint8Array {
  const covered = new Uint8Array(Math.max(0, to - from));
  // Only the first and last anchor of a run matter; scan inward from both ends.
  const anchor = (i: number) => !(sameAsNext(i) && sameAsNext(i + 1)) && unique(i);
  for (let start = from; start < to;) {
    if (!equal(start)) { start++; continue; }
    let end = start;
    while (end < to && equal(end)) end++;
    let first = start;
    while (first + 2 < end && !anchor(first)) first++;
    let last = end - 3;
    while (last > first && !anchor(last)) last--;
    if (first + 2 < end && last > first) {
      for (let x = first + 1; x <= last + 1; x++) if (!sameAsNext(x - 1) && !sameAsNext(x)) covered[x - from] = 1;
    }
    start = end;
  }
  return covered;
}
function certify(recent: readonly HistoryRow[], a: readonly number[], b: readonly number[], offset: number, reason: RowMatch['reason']): RowMatch {
  const result: RowMatch = { checks: [], contentMatches: [], repairs: [], reason };
  const from = Math.max(0, -offset), to = Math.min(a.length, b.length - offset);
  if (to <= from) return result;
  const base = Math.max(a.length, b.length) * 2 + 2;
  const countA = tripleCounts(a, base), countB = tripleCounts(b, base);
  const covered = classify(from, to, i => a[i] === b[i + offset], i => a[i] === a[i + 1], i => {
    const key = tripleKey(a, i, base);
    return countA.get(key) === 1 && countB.get(key) === 1;
  });
  for (let i = from; i < to; i++) {
    if (a[i] !== b[i + offset]) continue;
    (covered[i - from] ? result.checks : result.contentMatches).push({ lineId: recent[i]!.lineId, capturedRow: i + offset });
  }
  return result;
}

/** Only full retained captures certify uniqueness. A reduced tail is never a
 * substitute for evidence about the unseen ring, even if receiveSeq advanced. */
export function matchHistoryRows(
  recent: readonly HistoryRow[], captured: readonly CapturedRow[], scope: MatchScope,
): RowMatch {
  const empty = (reason: RowMatch['reason']): RowMatch => ({ checks: [], contentMatches: [], repairs: [], reason });
  if (!scope.completeRetainedTail) return empty('partial-tail');
  if (recent.some(r => r.sourceEpoch !== scope.sourceEpoch || r.geometryGeneration !== scope.geometryGeneration)) return empty('generation');
  const uncertain = scope.uncertainCapturedRows;
  // Common steady state: aligned rings with at most one drifted row. The
  // alignment is only a hypothesis; certifyAligned still demands unique
  // triples, and this path avoids interning 9,000 rows.
  if (recent.length >= 3 && recent.length === captured.length) {
    const equal = new Uint8Array(recent.length);
    let differences = 0;
    for (let i = 0; i < recent.length && differences < 2; i++) {
      if (!uncertain?.has(i) && equalHistoryRows(recent[i]!, captured[i]!)) equal[i] = 1; else differences++;
    }
    if (differences < 2) {
      const aligned = certifyAligned(recent, captured, 0, 0, equal, 'matched');
      if (!aligned.checks.length) aligned.reason = 'ambiguous';
      return aligned;
    }
  }
  const [a, b] = internRows([recent, captured], uncertain) as [number[], number[]];
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
  // The recent suffix is the parser's newest row at the fence, so tmux can
  // only hold the rows that arrived after it. A unique copy further back is
  // an older print of the same text (e.g. before a resize), never this row.
  if (scope.maxTailGap !== undefined && b.length - end > scope.maxTailGap) return empty('no-anchor');
  const anchor = a.slice(a.length - length);
  if (count !== 1 || new Set(anchor).size < 2 || occurrences(anchor, a) !== 1 || occurrences(anchor, b) !== 1) return empty('ambiguous');
  // The unique suffix fixes the offset only. Rows inside it are certified by
  // their own unique triples like every other row: a unique suffix can still
  // hold a blank run whose hidden identities were dropped/duplicated.
  const result = certify(recent, a, b, end - a.length, 'matched');
  if (!result.checks.length) result.reason = 'ambiguous';
  return result;
}

/** Index of the only exact occurrence of `pattern` (3 rows), else -1. A run
 * of three identical rows is never an anchor. */
function locateTriple(rows: readonly CapturedRow[], pattern: readonly CapturedRow[]): number {
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
    if (equalRowsAround(rows[i]!, pattern[0]!, probe) && equalRowsAround(rows[i + 1]!, pattern[1]!, probe) && equalRowsAround(rows[i + 2]!, pattern[2]!, probe)) {
      if (found >= 0) return -1;
      found = i;
    }
  }
  return found;
}
/** Uniqueness of a 3-row window. The first queries use an exact scan
 * (locateTriple); a caller that keeps asking gets a sampled index instead:
 * a sampled triple key seen once is exactly unique (an exact duplicate always
 * shares it); a repeated key is decided by exact comparison within its group.
 * Computed per call: caller rows may be mutated between captures. */
function tripleIndex(rows: readonly CapturedRow[]): (i: number) => boolean {
  let scans = 0;
  let indexed: ((i: number) => boolean) | undefined;
  return (i: number) => {
    if (!indexed && scans++ < 8) return locateTriple(rows, [rows[i]!, rows[i + 1]!, rows[i + 2]!]) === i;
    return (indexed ??= sampledTripleIndex(rows))(i);
  };
}
function sampledTripleIndex(rows: readonly CapturedRow[]): (i: number) => boolean {
  const keys = new Int32Array(rows.length);
  for (let y = 0; y < rows.length; y++) keys[y] = rowSampleKey(rows[y]!);
  const key = (i: number) => Math.imul(Math.imul(keys[i]! ^ 0x9e3779b9, 16777619) ^ keys[i + 1]!, 16777619) ^ Math.imul(keys[i + 2]!, 0x85ebca6b);
  const counts = new Map<number, number>();
  for (let i = 0; i + 2 < rows.length; i++) { const k = key(i); counts.set(k, (counts.get(k) ?? 0) + 1); }
  let groups: Map<number, number[]> | undefined;
  return (i: number) => {
    const k = key(i);
    if (counts.get(k) === 1) return true;
    if (!groups) {
      groups = new Map();
      for (let j = 0; j + 2 < rows.length; j++) {
        const g = key(j);
        if (counts.get(g)! > 1) { const list = groups.get(g); if (list) list.push(j); else groups.set(g, [j]); }
      }
    }
    let same = 0;
    for (const j of groups.get(k)!) {
      if (j === i || (equalHistoryRows(rows[j]!, rows[i]!) && equalHistoryRows(rows[j + 1]!, rows[i + 1]!) && equalHistoryRows(rows[j + 2]!, rows[i + 2]!))) {
        if (++same > 1) return false;
      }
    }
    return true;
  };
}
/** certify() for callers without interned IDs: `equal[i - from]` says whether
 * recent[i] equals captured[i + offset] exactly. */
function certifyAligned(recent: readonly HistoryRow[], captured: readonly CapturedRow[], offset: number, from: number, equal: Uint8Array, reason: RowMatch['reason']): RowMatch {
  const result: RowMatch = { checks: [], contentMatches: [], repairs: [], reason };
  const to = from + equal.length;
  let uniqueR: ((i: number) => boolean) | undefined, uniqueC: ((i: number) => boolean) | undefined;
  const same = new Int8Array(equal.length).fill(-1);
  // Neighbouring rows usually differ in the same column (counters, stamps):
  // test the column where the previous pair differed before a full compare.
  let probe = 0;
  const sameAsNext = (i: number) => {
    const k = i - from;
    if (same[k] === -1) {
      const x = recent[i]!, y = recent[i + 1]!;
      if (x.cells.length === y.cells.length && probe < x.cells.length && x.cells[probe]!.grapheme !== y.cells[probe]!.grapheme) same[k] = 0;
      else if (equalHistoryRows(x, y)) same[k] = 1;
      else {
        same[k] = 0;
        const n = Math.min(x.cells.length, y.cells.length);
        for (let c = 0; c < n; c++) if (x.cells[c]!.grapheme !== y.cells[c]!.grapheme) { probe = c; break; }
      }
    }
    return same[k] === 1;
  };
  const covered = classify(from, to, i => equal[i - from] === 1, sameAsNext, i => {
    uniqueR ??= tripleIndex(recent); uniqueC ??= tripleIndex(captured);
    return uniqueR(i) && uniqueC(i + offset);
  });
  for (let i = from; i < to; i++) {
    if (!equal[i - from]) continue;
    (covered[i - from] ? result.checks : result.contentMatches).push({ lineId: recent[i]!.lineId, capturedRow: i + offset });
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
  match(recent: readonly HistoryRow[], captured: readonly CapturedRow[], scope: MatchScope): RowMatch {
    const generation = `${scope.sourceEpoch}/${scope.geometryGeneration}`;
    if (this.generation !== generation) { this.reset(); this.generation = generation; }
    if (scope.completeRetainedTail) return matchHistoryRows(recent, captured, scope);
    const empty = (reason: RowMatch['reason']): RowMatch => ({ checks: [], contentMatches: [], repairs: [], reason });
    if (recent.some(r => r.sourceEpoch !== scope.sourceEpoch || r.geometryGeneration !== scope.geometryGeneration)) return empty('generation');
    const prior = [...this.checked.entries()];
    if (prior.length !== 3) return empty('partial-tail');
    const first = recent.findIndex(row => row.lineId === prior[0]![0]);
    if (first < 0 || prior.some(([id, row], n) => recent[first + n]?.lineId !== id || !equalHistoryRows(row, recent[first + n]!))) return empty('partial-tail');
    const uncertain = scope.uncertainCapturedRows;
    const pattern = prior.map(([, row]) => row);
    const at = locateTriple(captured, pattern);
    if (at < 0 || locateTriple(recent, pattern) !== first || [0, 1, 2].some(n => uncertain?.has(at + n))) return empty('ambiguous');
    const offset = at - first;
    // Scan only the captured overlap. A row is checked only inside a triple
    // unique in the parser ring and in this capture (FIX1-PLAN §2); other equal
    // rows are content-matched. No repair or index shift is ever inferred.
    const from = Math.max(0, -offset), to = Math.min(recent.length, captured.length - offset);
    const equal = new Uint8Array(Math.max(0, to - from));
    for (let i = from; i < to; i++) equal[i - from] = !uncertain?.has(i + offset) && equalHistoryRows(recent[i]!, captured[i + offset]!) ? 1 : 0;
    const result = certifyAligned(recent, captured, offset, from, equal, 'matched');
    // The newest captured row is never checked (no anchor below it), so the
    // chain only needs to advance when a row exists past the one after the seed.
    if (at + 4 < captured.length && !result.checks.some(check => check.capturedRow >= at + 3)) result.reason = 'ambiguous';
    return result;
  }
  remember(recent: readonly HistoryRow[], captured: readonly CapturedRow[], match: RowMatch): void {
    // Only the terminal verified triple is needed to seed the next chain.
    // Copying 128 full rows on every 200ms tick dominated collector work.
    // Seed from the last three checks that are consecutive in both captured
    // rows and the recent ring; any checked exact triple is valid. Checks are
    // normally ordered by row; sort defensively for other producers.
    this.checked.clear();
    const checks = match.checks.slice();
    if (checks.some((check, k) => k > 0 && checks[k - 1]!.capturedRow > check.capturedRow)) checks.sort((a, b) => a.capturedRow - b.capturedRow);
    let index: Map<number, number> | undefined;
    for (let k = checks.length - 1; k >= 2; k--) {
      const triple = [checks[k - 2]!, checks[k - 1]!, checks[k]!];
      if (triple[1]!.capturedRow !== triple[0]!.capturedRow + 1 || triple[2]!.capturedRow !== triple[1]!.capturedRow + 1) continue;
      // The terminal triple is normally near the ring end; scan back once and
      // index the ring only if that first candidate does not line up.
      let at: number | undefined;
      if (!index) {
        for (let i = recent.length - 1; i >= 0; i--) if (recent[i]!.lineId === triple[0]!.lineId) { at = i; break; }
        index = new Map();
      } else {
        if (!index.size) recent.forEach((row, i) => index!.set(row.lineId, i));
        at = index.get(triple[0]!.lineId);
      }
      if (at === undefined || recent[at + 1]?.lineId !== triple[1]!.lineId || recent[at + 2]?.lineId !== triple[2]!.lineId) continue;
      // Plain-field copy; structuredClone of three 80-cell rows per pane per
      // tick was the matcher's largest single cost.
      for (const check of triple) {
        const row = captured[check.capturedRow]!;
        this.checked.set(check.lineId, { softWrap: row.softWrap, cells: row.cells.map(cell => ({ ...cell })) });
      }
      return;
    }
  }
}
