import { createRequire } from "node:module";
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/history-row-matcher.ts
function cellKey(cell) {
  return JSON.stringify([cell.grapheme, cell.width, cell.continuation, cell.fg, cell.bg, cell.style]);
}
function equalCells(a, b, styleMask = -1) {
  return a.grapheme === b.grapheme && a.width === b.width && a.continuation === b.continuation && a.fg === b.fg && a.bg === b.bg && ((a.style ^ b.style) & styleMask) === 0;
}
var certifiedCache = new Map;
function certifiedRows(rows, styleMask) {
  let cache = certifiedCache.get(styleMask);
  if (!cache) {
    cache = new WeakMap;
    certifiedCache.set(styleMask, cache);
  }
  return rows.map((row) => {
    let cells = cache.get(row.cells);
    if (!cells) {
      cells = row.cells.every((cell) => (cell.style & ~styleMask) === 0) ? row.cells : row.cells.map((cell) => (cell.style & ~styleMask) === 0 ? cell : { ...cell, style: cell.style & styleMask });
      cache.set(row.cells, cells);
    }
    return cells === row.cells ? row : { cells, softWrap: row.softWrap };
  });
}
function rowKey(row) {
  return JSON.stringify([row.softWrap, row.cells.map(cellKey)]);
}
function equalHistoryRows(a, b) {
  if (a.softWrap !== b.softWrap || a.cells.length !== b.cells.length)
    return false;
  if (a.cells === b.cells)
    return true;
  for (let x = 0;x < a.cells.length; x++) {
    const c = a.cells[x], d = b.cells[x];
    if (c.grapheme !== d.grapheme || c.width !== d.width || c.continuation !== d.continuation || c.fg !== d.fg || c.bg !== d.bg || c.style !== d.style)
      return false;
  }
  return true;
}
function equalRowsAround(a, b, probe) {
  if (a.softWrap !== b.softWrap || a.cells.length !== b.cells.length)
    return false;
  if (a.cells === b.cells)
    return true;
  const same = (x) => {
    const c = a.cells[x], d = b.cells[x];
    return c.grapheme === d.grapheme && c.width === d.width && c.continuation === d.continuation && c.fg === d.fg && c.bg === d.bg && c.style === d.style;
  };
  const start = Math.min(probe, a.cells.length - 1);
  for (let x = start;x >= 0; x--)
    if (!same(x))
      return false;
  for (let x = start + 1;x < a.cells.length; x++)
    if (!same(x))
      return false;
  return true;
}
function rowSampleKey(row) {
  const cells = row.cells;
  let key = cells.length ^ (row.softWrap ? 1073741824 : 0);
  const mix = (x) => {
    const glyph = cells[x].grapheme;
    for (let c = 0;c < glyph.length; c++)
      key = Math.imul(key ^ glyph.charCodeAt(c), 16777619);
    key = Math.imul(key ^ 255, 16777619);
  };
  const head = Math.min(16, cells.length);
  for (let x = 0;x < head; x++)
    mix(x);
  for (let x = head + 7;x < cells.length - 1; x += 8)
    mix(x);
  if (cells.length > head)
    mix(cells.length - 1);
  return key;
}
function internRows(rows, uncertain) {
  const buckets = new Map;
  let id = 0;
  return rows.map((part, p) => part.map((row, y) => {
    if (p === 1 && uncertain?.has(y))
      return ++id;
    const key = rowSampleKey(row);
    const bucket = buckets.get(key);
    const found = bucket?.find((entry2) => equalHistoryRows(entry2.row, row));
    if (found)
      return found.id;
    const entry = { row, id: ++id };
    if (bucket)
      bucket.push(entry);
    else
      buckets.set(key, [entry]);
    return entry.id;
  }));
}
function zValues(values) {
  const z = Array(values.length).fill(0);
  let left = 0, right = 0;
  for (let i = 1;i < values.length; i++) {
    if (i <= right)
      z[i] = Math.min(right - i + 1, z[i - left]);
    while (i + z[i] < values.length && values[z[i]] === values[i + z[i]])
      z[i]++;
    if (i + z[i] - 1 > right) {
      left = i;
      right = i + z[i] - 1;
    }
  }
  return z;
}
function occurrences(pattern, values) {
  const z = zValues([...pattern, null, ...values]);
  let count = 0;
  for (let i = pattern.length + 1;i < z.length; i++)
    if (z[i] >= pattern.length)
      count++;
  return count;
}
function tripleCounts(values, base) {
  const counts = new Map;
  for (let i = 0;i + 2 < values.length; i++) {
    if (values[i] === values[i + 1] && values[i] === values[i + 2])
      continue;
    const key = tripleKey(values, i, base);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
function tripleKey(values, i, base) {
  return base < 200000 ? (values[i] * base + values[i + 1]) * base + values[i + 2] : `${values[i]},${values[i + 1]},${values[i + 2]}`;
}
function classify(from, to, equal, sameAsNext, unique) {
  const covered = new Uint8Array(Math.max(0, to - from));
  const anchor = (i) => !(sameAsNext(i) && sameAsNext(i + 1)) && unique(i);
  for (let start = from;start < to; ) {
    if (!equal(start)) {
      start++;
      continue;
    }
    let end = start;
    while (end < to && equal(end))
      end++;
    let first = start;
    while (first + 2 < end && !anchor(first))
      first++;
    let last = end - 3;
    while (last > first && !anchor(last))
      last--;
    if (first + 2 < end && last > first) {
      for (let x = first + 1;x <= last + 1; x++)
        if (!sameAsNext(x - 1) && !sameAsNext(x))
          covered[x - from] = 1;
    }
    start = end;
  }
  return covered;
}
function certify(recent, a, b, offset, reason) {
  const result = { checks: [], contentMatches: [], repairs: [], reason };
  const from = Math.max(0, -offset), to = Math.min(a.length, b.length - offset);
  if (to <= from)
    return result;
  const base = Math.max(a.length, b.length) * 2 + 2;
  const countA = tripleCounts(a, base), countB = tripleCounts(b, base);
  const covered = classify(from, to, (i) => a[i] === b[i + offset], (i) => a[i] === a[i + 1], (i) => {
    const key = tripleKey(a, i, base);
    return countA.get(key) === 1 && countB.get(key) === 1;
  });
  for (let i = from;i < to; i++) {
    if (a[i] !== b[i + offset])
      continue;
    (covered[i - from] ? result.checks : result.contentMatches).push({ lineId: recent[i].lineId, capturedRow: i + offset });
  }
  return result;
}
function matchHistoryRows(recent, captured, scope) {
  const empty = (reason) => ({ checks: [], contentMatches: [], repairs: [], reason });
  if (!scope.completeRetainedTail)
    return empty("partial-tail");
  if (recent.some((r) => r.sourceEpoch !== scope.sourceEpoch || r.geometryGeneration !== scope.geometryGeneration))
    return empty("generation");
  const uncertain = scope.uncertainCapturedRows;
  if (recent.length >= 3 && recent.length === captured.length) {
    const equal = new Uint8Array(recent.length);
    let differences = 0;
    for (let i = 0;i < recent.length && differences < 2; i++) {
      if (!uncertain?.has(i) && equalHistoryRows(recent[i], captured[i]))
        equal[i] = 1;
      else
        differences++;
    }
    if (differences < 2) {
      const aligned = certifyAligned(recent, captured, 0, 0, equal, "matched");
      if (!aligned.checks.length)
        aligned.reason = "ambiguous";
      return aligned;
    }
  }
  const [a, b] = internRows([recent, captured], uncertain);
  if (a.length < 3 || b.length < 3)
    return empty("no-anchor");
  const reversed = a.slice().reverse();
  const z = zValues([...reversed, null, ...b.slice().reverse()]);
  let length = 0, end = -1, count = 0;
  for (let i = 0;i < b.length; i++) {
    const n = z[a.length + 1 + i];
    if (n > length) {
      length = n;
      end = b.length - i;
      count = 1;
    } else if (n === length)
      count++;
  }
  if (length < 3)
    return empty("no-anchor");
  if (scope.maxTailGap !== undefined && b.length - end > scope.maxTailGap)
    return empty("no-anchor");
  const anchor = a.slice(a.length - length);
  if (count !== 1 || new Set(anchor).size < 2 || occurrences(anchor, a) !== 1 || occurrences(anchor, b) !== 1)
    return empty("ambiguous");
  const result = certify(recent, a, b, end - a.length, "matched");
  if (!result.checks.length)
    result.reason = "ambiguous";
  return result;
}
function locateTriple(rows, pattern) {
  if (equalHistoryRows(pattern[0], pattern[1]) && equalHistoryRows(pattern[0], pattern[2]))
    return -1;
  let probe = 0;
  for (let x = 0;x < pattern[0].cells.length; x++) {
    if (pattern[0].cells[x].grapheme !== pattern[1].cells[x]?.grapheme || pattern[0].cells[x].grapheme !== pattern[2].cells[x]?.grapheme) {
      probe = x;
      break;
    }
  }
  const glyph = pattern[0].cells[probe]?.grapheme;
  let found = -1;
  for (let i = 0;i + 2 < rows.length; i++) {
    if (rows[i].cells[probe]?.grapheme !== glyph)
      continue;
    if (equalRowsAround(rows[i], pattern[0], probe) && equalRowsAround(rows[i + 1], pattern[1], probe) && equalRowsAround(rows[i + 2], pattern[2], probe)) {
      if (found >= 0)
        return -1;
      found = i;
    }
  }
  return found;
}
function tripleIndex(rows) {
  let scans = 0;
  let indexed;
  return (i) => {
    if (!indexed && scans++ < 8)
      return locateTriple(rows, [rows[i], rows[i + 1], rows[i + 2]]) === i;
    return (indexed ??= sampledTripleIndex(rows))(i);
  };
}
function sampledTripleIndex(rows) {
  const keys = new Int32Array(rows.length);
  for (let y = 0;y < rows.length; y++)
    keys[y] = rowSampleKey(rows[y]);
  const key = (i) => Math.imul(Math.imul(keys[i] ^ 2654435769, 16777619) ^ keys[i + 1], 16777619) ^ Math.imul(keys[i + 2], 2246822507);
  const counts = new Map;
  for (let i = 0;i + 2 < rows.length; i++) {
    const k = key(i);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let groups;
  return (i) => {
    const k = key(i);
    if (counts.get(k) === 1)
      return true;
    if (!groups) {
      groups = new Map;
      for (let j = 0;j + 2 < rows.length; j++) {
        const g = key(j);
        if (counts.get(g) > 1) {
          const list = groups.get(g);
          if (list)
            list.push(j);
          else
            groups.set(g, [j]);
        }
      }
    }
    let same = 0;
    for (const j of groups.get(k)) {
      if (j === i || equalHistoryRows(rows[j], rows[i]) && equalHistoryRows(rows[j + 1], rows[i + 1]) && equalHistoryRows(rows[j + 2], rows[i + 2])) {
        if (++same > 1)
          return false;
      }
    }
    return true;
  };
}
function certifyAligned(recent, captured, offset, from, equal, reason) {
  const result = { checks: [], contentMatches: [], repairs: [], reason };
  const to = from + equal.length;
  let uniqueR, uniqueC;
  const same = new Int8Array(equal.length).fill(-1);
  let probe = 0;
  const sameAsNext = (i) => {
    const k = i - from;
    if (same[k] === -1) {
      const x = recent[i], y = recent[i + 1];
      if (x.cells.length === y.cells.length && probe < x.cells.length && x.cells[probe].grapheme !== y.cells[probe].grapheme)
        same[k] = 0;
      else if (equalHistoryRows(x, y))
        same[k] = 1;
      else {
        same[k] = 0;
        const n = Math.min(x.cells.length, y.cells.length);
        for (let c = 0;c < n; c++)
          if (x.cells[c].grapheme !== y.cells[c].grapheme) {
            probe = c;
            break;
          }
      }
    }
    return same[k] === 1;
  };
  const covered = classify(from, to, (i) => equal[i - from] === 1, sameAsNext, (i) => {
    uniqueR ??= tripleIndex(recent);
    uniqueC ??= tripleIndex(captured);
    return uniqueR(i) && uniqueC(i + offset);
  });
  for (let i = from;i < to; i++) {
    if (!equal[i - from])
      continue;
    (covered[i - from] ? result.checks : result.contentMatches).push({ lineId: recent[i].lineId, capturedRow: i + offset });
  }
  return result;
}

class IncrementalHistoryMatcher {
  checked = new Map;
  generation = "";
  reset() {
    this.checked.clear();
  }
  match(recent, captured, scope) {
    const generation = `${scope.sourceEpoch}/${scope.geometryGeneration}`;
    if (this.generation !== generation) {
      this.reset();
      this.generation = generation;
    }
    if (scope.completeRetainedTail)
      return matchHistoryRows(recent, captured, scope);
    const empty = (reason) => ({ checks: [], contentMatches: [], repairs: [], reason });
    if (recent.some((r) => r.sourceEpoch !== scope.sourceEpoch || r.geometryGeneration !== scope.geometryGeneration))
      return empty("generation");
    const prior = [...this.checked.entries()];
    if (prior.length !== 3)
      return empty("partial-tail");
    const first = recent.findIndex((row) => row.lineId === prior[0][0]);
    if (first < 0 || prior.some(([id, row], n) => recent[first + n]?.lineId !== id || !equalHistoryRows(row, recent[first + n])))
      return empty("partial-tail");
    const uncertain = scope.uncertainCapturedRows;
    const pattern = prior.map(([, row]) => row);
    const at = locateTriple(captured, pattern);
    if (at < 0 || locateTriple(recent, pattern) !== first || [0, 1, 2].some((n) => uncertain?.has(at + n)))
      return empty("ambiguous");
    const offset = at - first;
    const from = Math.max(0, -offset), to = Math.min(recent.length, captured.length - offset);
    const equal = new Uint8Array(Math.max(0, to - from));
    for (let i = from;i < to; i++)
      equal[i - from] = !uncertain?.has(i + offset) && equalHistoryRows(recent[i], captured[i + offset]) ? 1 : 0;
    const result = certifyAligned(recent, captured, offset, from, equal, "matched");
    if (at + 4 < captured.length && !result.checks.some((check) => check.capturedRow >= at + 3))
      result.reason = "ambiguous";
    return result;
  }
  remember(recent, captured, match) {
    this.checked.clear();
    const checks = match.checks.slice();
    if (checks.some((check, k) => k > 0 && checks[k - 1].capturedRow > check.capturedRow))
      checks.sort((a, b) => a.capturedRow - b.capturedRow);
    let index;
    for (let k = checks.length - 1;k >= 2; k--) {
      const triple = [checks[k - 2], checks[k - 1], checks[k]];
      if (triple[1].capturedRow !== triple[0].capturedRow + 1 || triple[2].capturedRow !== triple[1].capturedRow + 1)
        continue;
      let at;
      if (!index) {
        for (let i = recent.length - 1;i >= 0; i--)
          if (recent[i].lineId === triple[0].lineId) {
            at = i;
            break;
          }
        index = new Map;
      } else {
        if (!index.size)
          recent.forEach((row, i) => index.set(row.lineId, i));
        at = index.get(triple[0].lineId);
      }
      if (at === undefined || recent[at + 1]?.lineId !== triple[1].lineId || recent[at + 2]?.lineId !== triple[2].lineId)
        continue;
      for (const check of triple) {
        const row = captured[check.capturedRow];
        this.checked.set(check.lineId, { softWrap: row.softWrap, cells: row.cells.map((cell) => ({ ...cell })) });
      }
      return;
    }
  }
}
export {
  rowKey,
  matchHistoryRows,
  equalHistoryRows,
  equalCells,
  certifiedRows,
  cellKey,
  IncrementalHistoryMatcher
};
