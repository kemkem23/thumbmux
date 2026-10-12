// T11 independent oracle (NEWARCH flag-on lot 11-T), shared by the package
// demo suite and the host flag-on rigs in tests/integrations. The region
// between the markers is self-contained: MUTATION runs copy it verbatim.
// T11-ORACLE-BEGIN
export type T11Expected = { readonly text: string; readonly epoch: string };
export type T11Actual =
  | { readonly kind: 'row'; readonly pane: string; readonly epoch: string; readonly text: string }
  | { readonly kind: 'gap'; readonly pane: string; readonly positioned: boolean;
      readonly countKind: 'exact' | 'estimate' | 'unknown'; readonly missingCount: number | null; readonly lowerBound: number };
export type T11Mode = 'normal' | 'planned' | 'fault' | 'recoverable';
export type T11Verdict = { readonly violations: readonly string[]; readonly matched: number; readonly missing: number; readonly covered: number };

/** Longest strictly increasing subsequence; returns the kept positions. */
export function t11Lis(values: readonly number[]): Set<number> {
  const tails: number[] = []; const prev = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (values[tails[mid]!]! < values[i]!) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const kept = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) kept.add(i);
  return kept;
}

/** Judge one pane's product timeline against the producer's literal events. */
export function t11JudgeTimeline(pane: string, expected: readonly T11Expected[], actual: readonly T11Actual[], mode: T11Mode): T11Verdict {
  const v = new Set<string>();
  const occurrences = new Map<string, number[]>();
  expected.forEach((e, i) => occurrences.set(e.text, [...(occurrences.get(e.text) ?? []), i]));
  const matchOf = new Array<number>(actual.length).fill(-1); // actual index -> expected index
  const misplaced = new Set<number>(); // expected events present but out of order
  const rowIdx: number[] = [];
  actual.forEach((a, i) => {
    if (a.pane !== pane) { v.add('cross-pane'); return; }
    if (a.kind === 'row') rowIdx.push(i);
    else if (!a.positioned) v.add('unpositioned-gap');
  });
  // 1. Unique texts are anchors (producer-stamped IDs); order = LIS over expected index.
  const anchors = rowIdx.filter(i => (occurrences.get((actual[i] as { text: string }).text)?.length ?? 0) === 1);
  const anchorExp = anchors.map(i => occurrences.get((actual[i] as { text: string }).text)![0]!);
  const kept = t11Lis(anchorExp);
  const usedExp = new Set<number>();
  anchors.forEach((ai, k) => { if (kept.has(k)) { matchOf[ai] = anchorExp[k]!; usedExp.add(anchorExp[k]!); } });
  // 2. Repeated (unstamped) texts: count-preserving in-order match between anchors.
  const boundaries = [-1, ...anchors.filter((_, k) => kept.has(k)), actual.length];
  for (let b = 0; b + 1 < boundaries.length; b++) {
    const lo = boundaries[b]!, hi = boundaries[b + 1]!;
    const eLo = lo < 0 ? -1 : matchOf[lo]!, eHi = hi >= actual.length ? expected.length : matchOf[hi]!;
    let cursor = eLo + 1;
    for (let i = lo + 1; i < hi; i++) {
      const a = actual[i]!;
      if (a.kind !== 'row' || a.pane !== pane || (occurrences.get(a.text)?.length ?? 0) < 2) continue;
      let e = cursor;
      while (e < eHi && (expected[e]!.text !== a.text || usedExp.has(e))) e++;
      if (e < eHi) { matchOf[i] = e; usedExp.add(e); cursor = e + 1; }
    }
  }
  // 3. Every unmatched row is a duplicate, an order violation or an extra.
  for (const i of rowIdx) {
    if (matchOf[i]! >= 0) { if ((actual[i] as { epoch: string }).epoch !== expected[matchOf[i]!]!.epoch) v.add('wrong-epoch'); continue; }
    const owners = occurrences.get((actual[i] as { text: string }).text);
    if (!owners) v.add('extra');
    else if (owners.every(e => usedExp.has(e))) v.add('duplicate');
    else { v.add('order'); misplaced.add(owners.find(e => !usedExp.has(e))!); }
  }
  // 4. Missing runs need a positioned gap strictly between their matched neighbours.
  const posOfExp = new Map<number, number>();
  matchOf.forEach((e, i) => { if (e >= 0) posOfExp.set(e, i); });
  const gapAt = (lo: number, hi: number) => actual.some((a, i) => i > lo && i < hi && a.kind === 'gap' && a.pane === pane && a.positioned);
  const present = (e: number) => usedExp.has(e) || misplaced.has(e);
  let missing = 0, covered = 0;
  for (let e = 0; e < expected.length; e++) {
    if (present(e)) continue;
    let end = e; while (end + 1 < expected.length && !present(end + 1)) end++;
    const run = end - e + 1; missing += run;
    const lo = e === 0 ? -1 : posOfExp.get(e - 1)!;
    const hi = end + 1 >= expected.length ? actual.length : posOfExp.get(end + 1)!;
    if (gapAt(lo, hi)) covered += run; else v.add('silent-missing');
    e = end;
  }
  // 5. Count claims: grouped per interval between matched rows.
  const matchedPos = [...posOfExp.values()].sort((a, b) => a - b);
  const groups = new Map<string, { gaps: Extract<T11Actual, { kind: 'gap' }>[]; missing: number }>();
  actual.forEach((a, i) => {
    if (a.kind !== 'gap' || a.pane !== pane || !a.positioned) return;
    const lo = [...matchedPos].reverse().find(p => p < i) ?? -1;
    const hi = matchedPos.find(p => p > i) ?? actual.length;
    const eLo = lo < 0 ? -1 : matchOf[lo]!, eHi = hi >= actual.length ? expected.length : matchOf[hi]!;
    let m = 0; for (let e = eLo + 1; e < eHi; e++) if (!present(e)) m++;
    const key = `${lo}:${hi}`;
    const g = groups.get(key) ?? { gaps: [], missing: m }; g.gaps.push(a); groups.set(key, g);
  });
  for (const { gaps, missing: m } of groups.values()) {
    for (const g of gaps) {
      if (g.countKind === 'unknown' && g.missingCount !== null) v.add('unknown-as-number');
      if (g.countKind !== 'unknown' && g.missingCount === null) v.add('known-count-null');
    }
    if (gaps.every(g => g.countKind === 'exact') && gaps.reduce((s, g) => s + (g.missingCount ?? 0), 0) !== m) v.add('exact-count-wrong');
    if (gaps.reduce((s, g) => s + g.lowerBound, 0) > m) v.add('lower-bound-exceeds');
  }
  // 6. Mode: normal/planned allow no gap and no loss; a recoverable fixture must recover.
  if (mode === 'normal' || mode === 'planned') {
    if (actual.some(a => a.kind === 'gap')) v.add('gap-in-normal');
    if (missing) v.add('missing-in-normal');
  }
  if (mode === 'recoverable' && missing) v.add('not-recovered');
  return { violations: [...v].sort(), matched: usedExp.size, missing, covered };
}

/** Raw spool replay judge: exact bytes, one epoch, contiguous offsets from 0. */
export function t11JudgeRawReplay(oracle: Uint8Array, epoch: string,
  records: readonly { readonly epoch: string; readonly start: number; readonly end: number; readonly bytes: Uint8Array }[]): string[] {
  const v = new Set<string>(); let offset = 0;
  for (const r of records) {
    if (r.epoch !== epoch) { v.add('wrong-epoch'); continue; }
    if (r.end - r.start !== r.bytes.length) v.add('length-mismatch');
    if (r.start > offset) v.add('offset-hole');
    if (r.start < offset) v.add('offset-overlap');
    for (let i = 0; i < r.bytes.length; i++) if (oracle[r.start + i] !== r.bytes[i]) { v.add('byte-mismatch'); break; }
    offset = Math.max(offset, r.end);
  }
  if (offset < oracle.length) v.add('short');
  if (offset > oracle.length) v.add('long');
  return [...v].sort();
}

/** S's independent raw oracle (02-S evidence/fixture-vectors.json), regenerated. */
export function t11RawOracle(): Uint8Array {
  const parts: string[] = ['\x1b[31m'];
  for (let i = 0; i < 4608; i++) parts.push((i === 101 || i === 102 ? 'REPEATED' : `${String(i).padStart(5, '0')}: กข界 é`) + '\r\n');
  parts.push('\x1b[0mEND');
  const text = new TextEncoder().encode(parts.join(''));
  const out = new Uint8Array(text.length + 2); out.set(text); out.set([0x00, 0xff], text.length);
  return out;
}

export const t11Ev = (n: number, epoch = 'e1') => ({ text: `EV${String(n).padStart(5, '0')}`, epoch });
export const t11Row = (n: number, epoch = 'e1', pane = 'p1'): T11Actual => ({ kind: 'row', pane, epoch, text: `EV${String(n).padStart(5, '0')}` });
export const t11Gap = (countKind: 'exact' | 'estimate' | 'unknown', missingCount: number | null, lowerBound = 0, positioned = true): T11Actual =>
  ({ kind: 'gap', pane: 'p1', positioned, countKind, missingCount, lowerBound });
export const t11Range = (a: number, b: number, epoch = 'e1') => Array.from({ length: b - a + 1 }, (_, i) => t11Row(a + i, epoch));

/** Adversarial timelines with literal verdicts. Expected codes are hand-written. */
export function t11TimelineFixtures(): { name: string; mode: T11Mode; expected: T11Expected[]; actual: T11Actual[]; violations: string[] }[] {
  const base = Array.from({ length: 100 }, (_, i) => t11Ev(i + 1));
  // Two identical adjacent events (101,102 in S's raw oracle) carry no stamp.
  const rep: T11Expected[] = [t11Ev(1), t11Ev(2), { text: 'REPEATED', epoch: 'e1' }, { text: 'REPEATED', epoch: 'e1' }, t11Ev(3)];
  const r = (text: string): T11Actual => ({ kind: 'row', pane: 'p1', epoch: 'e1', text });
  return [
    { name: 'clean exact timeline', mode: 'normal', expected: base, actual: t11Range(1, 100), violations: [] },
    { name: 'duplicate stamped row', mode: 'fault', expected: base, actual: [...t11Range(1, 50), t11Row(50), ...t11Range(51, 100)], violations: ['duplicate'] },
    { name: 'two rows swapped', mode: 'fault', expected: base, actual: [...t11Range(1, 49), t11Row(51), t11Row(50), ...t11Range(52, 100)], violations: ['order'] },
    { name: 'prefix exact, suffix reordered (no prefix-only check)', mode: 'fault', expected: base, actual: [...t11Range(1, 60), t11Row(99), ...t11Range(61, 98), t11Row(100)], violations: ['order'] },
    { name: 'one row silently dropped', mode: 'fault', expected: base, actual: [...t11Range(1, 40), ...t11Range(42, 100)], violations: ['silent-missing'] },
    { name: 'Q21: 13 lost under an unknown positioned gap', mode: 'fault', expected: base, actual: [...t11Range(1, 40), t11Gap('unknown', null), ...t11Range(54, 100)], violations: [] },
    { name: 'Q21: exact 13 (>5) accepted', mode: 'fault', expected: base, actual: [...t11Range(1, 40), t11Gap('exact', 13, 13), ...t11Range(54, 100)], violations: [] },
    { name: 'gap drawn at the wrong place', mode: 'fault', expected: base, actual: [...t11Range(1, 40), ...t11Range(54, 70), t11Gap('unknown', null), ...t11Range(71, 100)], violations: ['silent-missing'] },
    { name: 'unknown encoded as 0', mode: 'fault', expected: base, actual: [...t11Range(1, 40), t11Gap('unknown', 0), ...t11Range(54, 100)], violations: ['unknown-as-number'] },
    { name: 'exact count off by one', mode: 'fault', expected: base, actual: [...t11Range(1, 40), t11Gap('exact', 12, 12), ...t11Range(54, 100)], violations: ['exact-count-wrong'] },
    { name: 'estimate lower bound above real loss', mode: 'fault', expected: base, actual: [...t11Range(1, 40), t11Gap('estimate', 20, 20), ...t11Range(54, 100)], violations: ['lower-bound-exceeds'] },
    { name: 'session-wide marker without position', mode: 'fault', expected: base, actual: [t11Gap('unknown', null, 0, false), ...t11Range(1, 40), ...t11Range(54, 100)], violations: ['silent-missing', 'unpositioned-gap'] },
    { name: 'EOF tail dropped silently', mode: 'fault', expected: base, actual: t11Range(1, 80), violations: ['silent-missing'] },
    { name: 'EOF tail dropped behind a trailing gap', mode: 'fault', expected: base, actual: [...t11Range(1, 80), t11Gap('unknown', null)], violations: [] },
    { name: 'normal path may not use a gap even with nothing lost', mode: 'normal', expected: base, actual: [...t11Range(1, 50), t11Gap('unknown', null), ...t11Range(51, 100)], violations: ['gap-in-normal'] },
    { name: 'planned switch loss hidden behind a gap', mode: 'planned', expected: base, actual: [...t11Range(1, 50), t11Gap('exact', 2, 2), ...t11Range(53, 100)], violations: ['gap-in-normal', 'missing-in-normal'] },
    { name: 'recoverable fixture answered with a gap', mode: 'recoverable', expected: base, actual: [...t11Range(1, 50), t11Gap('unknown', null), ...t11Range(60, 100)], violations: ['not-recovered'] },
    { name: 'cross-pane row leaked in', mode: 'fault', expected: base, actual: [...t11Range(1, 50), t11Row(51, 'e1', 'p2'), ...t11Range(51, 100)], violations: ['cross-pane'] },
    { name: 'old-epoch callback row accepted', mode: 'fault', expected: base, actual: [...t11Range(1, 50), t11Row(51, 'e0'), ...t11Range(52, 100)], violations: ['wrong-epoch'] },
    { name: 'foreign text appended', mode: 'fault', expected: base, actual: [...t11Range(1, 100), r('ghost')], violations: ['extra'] },
    { name: 'identical adjacent events both kept', mode: 'normal', expected: rep, actual: [r('EV00001'), r('EV00002'), r('REPEATED'), r('REPEATED'), r('EV00003')], violations: [] },
    { name: 'identical adjacent events collapsed (Set(text) dedup)', mode: 'fault', expected: rep, actual: [r('EV00001'), r('EV00002'), r('REPEATED'), r('EV00003')], violations: ['silent-missing'] },
    { name: 'identical adjacent events tripled', mode: 'fault', expected: rep, actual: [r('EV00001'), r('EV00002'), r('REPEATED'), r('REPEATED'), r('REPEATED'), r('EV00003')], violations: ['duplicate'] },
  ];
}

/** Raw replay adversaries cut at S's split points. */
export function t11RawFixtures(oracle: Uint8Array) {
  const cuts = [0, 1, 2, 7, 16383, 16384, 32769, oracle.length - 1, oracle.length];
  const clean = cuts.slice(0, -1).map((start, i) => ({ epoch: 'E1', start, end: cuts[i + 1]!, bytes: oracle.slice(start, cuts[i + 1]!) }));
  const flipped = clean.map(r => ({ ...r, bytes: r.bytes.slice() })); flipped[5]!.bytes[0]! ^= 0x01;
  return [
    { name: 'clean split replay', records: clean, violations: [] as string[] },
    { name: 'dropped chunk', records: clean.filter((_, i) => i !== 4), violations: ['offset-hole'] },
    { name: 'duplicated chunk', records: [...clean.slice(0, 5), clean[4]!, ...clean.slice(5)], violations: ['offset-overlap'] },
    { name: 'reordered chunks', records: [clean[0]!, clean[2]!, clean[1]!, ...clean.slice(3)], violations: ['offset-hole', 'offset-overlap'] },
    { name: 'flipped byte', records: flipped, violations: ['byte-mismatch'] },
    { name: 'chunk from another epoch', records: clean.map((r, i) => i === 3 ? { ...r, epoch: 'E0' } : r), violations: ['offset-hole', 'wrong-epoch'] },
    { name: 'truncated tail (no fake EOF)', records: clean.slice(0, -1), violations: ['short'] },
    { name: 'length field lies', records: clean.map((r, i) => i === 6 ? { ...r, end: r.end + 1 } : r), violations: ['length-mismatch', 'offset-overlap'] },
  ];
}

/** Throws on the first verdict that differs from its literal expectation. */
export function t11OracleSelfTest(): string[] {
  const names: string[] = [];
  for (const f of t11TimelineFixtures()) {
    const got = t11JudgeTimeline('p1', f.expected, f.actual, f.mode).violations.join(',');
    if (got !== f.violations.join(',')) throw new Error(`T11 timeline fixture "${f.name}": expected [${f.violations}] got [${got}]`);
    names.push(f.name);
  }
  const oracle = t11RawOracle();
  for (const f of t11RawFixtures(oracle)) {
    const got = t11JudgeRawReplay(oracle, 'E1', f.records).join(',');
    if (got !== f.violations.join(',')) throw new Error(`T11 raw fixture "${f.name}": expected [${f.violations}] got [${got}]`);
    names.push(f.name);
  }
  return names;
}
// T11-ORACLE-END
