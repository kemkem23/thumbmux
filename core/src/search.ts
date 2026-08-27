import { stripTerminalControls } from './terminal-controls';

export type SearchMode = 'plain' | 'regex-lite';
export type SearchOptions = { mode?: SearchMode; caseSensitive?: boolean };
export type SearchMatch = { line: number; start: number; end: number };

export type SearchErrorCode =
  | 'empty-query'
  | 'pattern-too-long'
  | 'unsupported-syntax'
  | 'malformed-pattern'
  | 'invalid-bound'
  | 'result-limit';
export type SearchError = { code: SearchErrorCode; message: string };
export type SearchResult = {
  matches: SearchMatch[];
  error: SearchError | null;
};

const MAX_PATTERN_UNITS = 256;
const MAX_MATCHES = 10_000;
const MAX_QUANT = 100;

type Quantifier = { min: number; max: number | null };
type RegexNode =
  | { kind: 'start-anchor'; quant: Quantifier }
  | { kind: 'end-anchor'; quant: Quantifier }
  | { kind: 'dot'; quant: Quantifier }
  | { kind: 'literal'; value: string; quant: Quantifier }
  | {
      kind: 'class';
      singles: number[];
      ranges: Array<{ start: number; end: number }>;
      quant: Quantifier;
    };

type ParserError = SearchError | null;

function createError(code: SearchErrorCode, message: string): SearchError {
  return { code, message };
}

/** UTF-16 width of the code point starting at `offset` (1 or 2). */
function codePointWidth(s: string, offset: number): number {
  const cp = s.codePointAt(offset);
  return cp !== undefined && cp > 0xffff ? 2 : 1;
}

/** Slice one full code point at `offset` as a string. */
function sliceCodePoint(s: string, offset: number): string {
  return s.slice(offset, offset + codePointWidth(s, offset));
}

type FoldedVisibleText = {
  text: string;
  starts: number[];
  ends: number[];
};

// Case folding can expand a Unicode scalar (for example, U+0130).  Searching
// the folded string directly is fine, but the span must point back to the
// original visible UTF-16 coordinates rather than the expanded folded index.
function foldVisibleText(value: string): FoldedVisibleText {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];

  for (let offset = 0; offset < value.length;) {
    const codePoint = value.codePointAt(offset);
    const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    const folded = value.slice(offset, offset + width).toLowerCase();
    text += folded;
    for (let unit = 0; unit < folded.length; unit += 1) {
      starts.push(offset);
      ends.push(offset + width);
    }
    offset += width;
  }

  return { text, starts, ends };
}

function parseEscapedChar(
  pattern: string,
  at: number,
): { value: string; next: number; error: ParserError } {
  const ch = pattern[at + 1];
  if (ch === undefined) {
    return { value: '', next: at, error: createError('malformed-pattern', 'incomplete escape sequence') };
  }

  if (ch >= '0' && ch <= '9') {
    return {
      value: '',
      next: at,
      error: createError('unsupported-syntax', 'backreference escapes are not supported'),
    };
  }

  switch (ch) {
    case 'n':
      return { value: '\n', next: at + 2, error: null };
    case 'r':
      return { value: '\r', next: at + 2, error: null };
    case 't':
      return { value: '\t', next: at + 2, error: null };
    case 'f':
      return { value: '\f', next: at + 2, error: null };
    case 'v':
      return { value: '\v', next: at + 2, error: null };
    default:
      return { value: ch, next: at + 2, error: null };
  }
}

function parseClassEscapedChar(
  pattern: string,
  at: number,
): { value: number; next: number; error: ParserError } {
  if (at + 1 >= pattern.length) {
    return { value: -1, next: at, error: createError('malformed-pattern', 'incomplete escaped class character') };
  }

  const ch = pattern[at + 1];

  if (ch >= '0' && ch <= '9') {
    return {
      value: -1,
      next: at,
      error: createError('unsupported-syntax', 'backreference escapes are not supported'),
    };
  }

  switch (ch) {
    case 'n':
      return { value: '\n'.charCodeAt(0), next: at + 2, error: null };
    case 'r':
      return { value: '\r'.charCodeAt(0), next: at + 2, error: null };
    case 't':
      return { value: '\t'.charCodeAt(0), next: at + 2, error: null };
    case 'f':
      return { value: '\f'.charCodeAt(0), next: at + 2, error: null };
    case 'v':
      return { value: '\v'.charCodeAt(0), next: at + 2, error: null };
    default: {
      // Full code point so escaped astral atoms (`[\😀]`) are one class atom.
      const cp = pattern.codePointAt(at + 1)!;
      const width = cp > 0xffff ? 2 : 1;
      return { value: cp, next: at + 1 + width, error: null };
    }
  }
}

function parseQuantifier(
  pattern: string,
  at: number,
): { quant: Quantifier; next: number; error: ParserError } {
  const ch = pattern[at];
  if (ch === '?') {
    return { quant: { min: 0, max: 1 }, next: at + 1, error: null };
  }
  if (ch === '*') {
    return { quant: { min: 0, max: null }, next: at + 1, error: null };
  }
  if (ch === '+') {
    return { quant: { min: 1, max: null }, next: at + 1, error: null };
  }

  if (ch !== '{') {
    return { quant: { min: 1, max: 1 }, next: at, error: null };
  }

  let i = at + 1;
  if (i >= pattern.length) {
    return { quant: { min: 1, max: 1 }, next: at, error: createError('malformed-pattern', 'incomplete quantifier') };
  }

  const readNumber = (start: number) => {
    if (start >= pattern.length || pattern[start] < '0' || pattern[start] > '9') return null;
    let value = 0;
    let end = start;
    while (end < pattern.length && pattern[end] >= '0' && pattern[end] <= '9') {
      value = value * 10 + (pattern.charCodeAt(end) - 48);
      end += 1;
    }
    return { value, end };
  };

  const first = readNumber(i);
  if (first === null) {
    return {
      quant: { min: 1, max: 1 },
      next: at,
      error: createError('malformed-pattern', 'invalid bounded quantifier'),
    };
  }
  i = first.end;

  if (i < pattern.length && pattern[i] === '}') {
    const n = first.value;
    if (n > MAX_QUANT) {
      return {
        quant: { min: 1, max: 1 },
        next: at,
        error: createError('invalid-bound', `quantifier bound ${n} exceeds ${MAX_QUANT}`),
      };
    }
    return { quant: { min: n, max: n }, next: i + 1, error: null };
  }

  if (i >= pattern.length || pattern[i] !== ',') {
    return {
      quant: { min: 1, max: 1 },
      next: at,
      error: createError('malformed-pattern', 'invalid bounded quantifier'),
    };
  }

  const commaAfter = i + 1;
  const second = readNumber(commaAfter);
  if (second === null) {
    return {
      quant: { min: 1, max: 1 },
      next: at,
      error: createError('malformed-pattern', 'invalid bounded quantifier'),
    };
  }
  i = second.end;

  if (i >= pattern.length || pattern[i] !== '}') {
    return {
      quant: { min: 1, max: 1 },
      next: at,
      error: createError('malformed-pattern', 'invalid bounded quantifier'),
    };
  }

  const min = first.value;
  const max = second.value;
  if (max > MAX_QUANT || min > MAX_QUANT) {
    return {
      quant: { min: 1, max: 1 },
      next: at,
      error: createError('invalid-bound', `quantifier bound exceeds ${MAX_QUANT}`),
    };
  }
  if (min > max) {
    return {
      quant: { min: 1, max: 1 },
      next: at,
      error: createError('invalid-bound', 'lower bound exceeds upper bound'),
    };
  }

  return { quant: { min, max }, next: i + 1, error: null };
}

function parseCharClass(
  pattern: string,
  at: number,
): { node: RegexNode | null; next: number; error: ParserError } {
  let i = at + 1;
  const singles: number[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  let count = 0;

  const pushRange = (low: number, high: number) => {
    if (low > high) {
      return createError('malformed-pattern', 'invalid character class range');
    }
    ranges.push({ start: low, end: high });
  };

  while (i < pattern.length) {
    if (pattern[i] === ']') {
      if (count === 0) {
        return { node: null, next: i + 1, error: createError('malformed-pattern', 'empty character class') };
      }
      return {
        node: {
          kind: 'class',
          singles,
          ranges,
          quant: { min: 1, max: 1 },
        },
        next: i + 1,
        error: null,
      };
    }

    let lowCode: number;
    if (pattern[i] === '\\') {
      const result = parseClassEscapedChar(pattern, i);
      if (result.error) return { node: null, next: at, error: result.error };
      lowCode = result.value;
      i = result.next;
    } else {
      // Astral (emoji) class atoms are one code point, not two surrogates.
      lowCode = pattern.codePointAt(i)!;
      i += lowCode > 0xffff ? 2 : 1;
    }
    count += 1;

    if (i < pattern.length && pattern[i] === '-' && i + 1 < pattern.length && pattern[i + 1] !== ']') {
      i += 1;
      let highCode: number;
      if (pattern[i] === '\\') {
        const result = parseClassEscapedChar(pattern, i);
        if (result.error) return { node: null, next: at, error: result.error };
        highCode = result.value;
        i = result.next;
      } else {
        highCode = pattern.codePointAt(i)!;
        i += highCode > 0xffff ? 2 : 1;
      }
      const err = pushRange(lowCode, highCode);
      if (err) return { node: null, next: at, error: err };
      continue;
    }

    if (i < pattern.length && pattern[i] === '-') {
      // trailing '-' is malformed in this constrained grammar.
      return { node: null, next: at, error: createError('malformed-pattern', 'invalid character class range') };
    }

    singles.push(lowCode);
  }

  return { node: null, next: pattern.length, error: createError('malformed-pattern', 'unterminated character class') };
}

function parseRegexLite(query: string): { nodes: RegexNode[]; error: ParserError } {
  if (query.length > MAX_PATTERN_UNITS) {
    return { nodes: [], error: createError('pattern-too-long', `pattern exceeds ${MAX_PATTERN_UNITS} UTF-16 units`) };
  }

  const nodes: RegexNode[] = [];
  let i = 0;

  while (i < query.length) {
    const ch = query[i];
    let node: RegexNode | null = null;

    if (ch === '(' || ch === ')' || ch === '|') {
      return { nodes: [], error: createError('unsupported-syntax', 'unsupported regex operator') };
    }

    if (ch === '*' || ch === '+' || ch === '?' || ch === '{' || ch === '}') {
      return {
        nodes: [],
        error: createError(
          ch === '{' || ch === '}'
            ? 'malformed-pattern'
            : 'unsupported-syntax',
          'quantifier without atom',
        ),
      };
    }

    if (ch === '^') {
      node = { kind: 'start-anchor', quant: { min: 1, max: 1 } };
      i += 1;
    } else if (ch === '$') {
      node = { kind: 'end-anchor', quant: { min: 1, max: 1 } };
      i += 1;
    } else if (ch === '.') {
      node = { kind: 'dot', quant: { min: 1, max: 1 } };
      i += 1;
    } else if (ch === '[') {
      const result = parseCharClass(query, i);
      if (result.error) return { nodes: [], error: result.error };
      node = result.node;
      i = result.next;
    } else if (ch === '\\') {
      const result = parseEscapedChar(query, i);
      if (result.error) return { nodes: [], error: result.error };
      node = { kind: 'literal', value: result.value, quant: { min: 1, max: 1 } };
      i = result.next;
    } else {
      // Bare astral literals (e.g. emoji) are one atom, not two surrogate units.
      const cp = query.codePointAt(i)!;
      const width = cp > 0xffff ? 2 : 1;
      node = { kind: 'literal', value: query.slice(i, i + width), quant: { min: 1, max: 1 } };
      i += width;
    }

    if (node === null) {
      return { nodes: [], error: createError('malformed-pattern', 'unable to parse pattern') };
    }

    if (i < query.length) {
      const q = query[i];
      if (q === '?' || q === '*' || q === '+' || q === '{') {
        const qResult = parseQuantifier(query, i);
        if (qResult.error) return { nodes: [], error: qResult.error };
        if (node.kind === 'start-anchor' || node.kind === 'end-anchor') {
          return { nodes: [], error: createError('unsupported-syntax', 'anchored token cannot be quantified') };
        }
        node = { ...node, quant: qResult.quant } as RegexNode;
        i = qResult.next;
      }
    }

    nodes.push(node);
  }

  if (nodes.length === 0) {
    return { nodes: [], error: createError('malformed-pattern', 'empty pattern') };
  }

  return { nodes, error: null };
}

function classMatches(node: Extract<RegexNode, { kind: 'class' }>, ch: string, caseSensitive: boolean): boolean {
  // Compare full code points so surrogate halves never match a class atom.
  const code = ch.codePointAt(0)!;

  // Case-sensitive: only the original code-point range / singles. Folded
  // comparison must not run here — otherwise [A-Z] matches "b".
  if (caseSensitive) {
    for (let i = 0; i < node.ranges.length; i += 1) {
      const range = node.ranges[i];
      if (code >= range.start && code <= range.end) return true;
    }
    for (let i = 0; i < node.singles.length; i += 1) {
      if (node.singles[i] === code) return true;
    }
    return false;
  }

  // Case-insensitive: accept an original-range hit, then fold both sides.
  const left = ch.toLowerCase();
  for (let i = 0; i < node.ranges.length; i += 1) {
    const range = node.ranges[i];
    if (code >= range.start && code <= range.end) return true;
    const foldedStart = String.fromCodePoint(range.start).toLowerCase();
    const foldedEnd = String.fromCodePoint(range.end).toLowerCase();
    if (left >= foldedStart && left <= foldedEnd) return true;
  }

  for (let i = 0; i < node.singles.length; i += 1) {
    const item = String.fromCodePoint(node.singles[i]);
    if (item.toLowerCase() === left) return true;
  }

  return false;
}

function literalMatches(value: string, ch: string, caseSensitive: boolean): boolean {
  return caseSensitive
    ? value === ch
    : value.toLowerCase() === ch.toLowerCase();
}

function consumeMatches(node: RegexNode, ch: string, caseSensitive: boolean): boolean {
  switch (node.kind) {
    case 'dot':
      return ch !== '';
    case 'literal':
      return literalMatches(node.value, ch, caseSensitive);
    case 'class':
      return classMatches(node, ch, caseSensitive);
    default:
      return false;
  }
}

function buildStateTables(nodes: readonly RegexNode[]): {
  stateToken: number[];
  stateRep: number[];
  firstStateForToken: number[];
  acceptState: number;
} {
  const stateToken: number[] = [];
  const stateRep: number[] = [];
  const firstStateForToken: number[] = [];

  for (let i = 0; i < nodes.length; i += 1) {
    firstStateForToken[i] = stateToken.length;
    const max = nodes[i].quant.max;
    const repCount = max === null ? 2 : max + 1;
    for (let rep = 0; rep < repCount; rep += 1) {
      stateToken.push(i);
      stateRep.push(rep);
    }
  }

  return {
    stateToken,
    stateRep,
    firstStateForToken,
    acceptState: stateToken.length,
  };
}

function addState(
  id: number,
  closureStack: number[],
  seen: Uint32Array,
  visitTag: number,
) {
  if (seen[id] === visitTag) return;
  closureStack.push(id);
}

function epsilonClose(
  initial: number[],
  lineLen: number,
  pos: number,
  nodes: readonly RegexNode[],
  tables: ReturnType<typeof buildStateTables>,
  seen: Uint32Array,
  visitTag: number,
): number[] {
  const out: number[] = [];
  const stack = [...initial];

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen[id] === visitTag) continue;
    seen[id] = visitTag;

    if (id === tables.acceptState) {
      out.push(id);
      continue;
    }

    const tokenIndex = tables.stateToken[id];
    const repeats = tables.stateRep[id];
    const node = nodes[tokenIndex];
    if (node.kind === 'start-anchor') {
      if (pos === 0) {
        if (tokenIndex + 1 >= nodes.length) {
          addState(tables.acceptState, stack, seen, visitTag);
        } else {
          addState(tables.firstStateForToken[tokenIndex + 1], stack, seen, visitTag);
        }
      }
      continue;
    }
    if (node.kind === 'end-anchor') {
      if (pos === lineLen) {
        if (tokenIndex + 1 >= nodes.length) {
          addState(tables.acceptState, stack, seen, visitTag);
        } else {
          addState(tables.firstStateForToken[tokenIndex + 1], stack, seen, visitTag);
        }
      }
      continue;
    }

    // Keep the consuming state available.
    out.push(id);

    if (repeats >= node.quant.min) {
      if (tokenIndex + 1 >= nodes.length) {
        addState(tables.acceptState, stack, seen, visitTag);
      } else {
        addState(tables.firstStateForToken[tokenIndex + 1], stack, seen, visitTag);
      }
    }
  }

  return out;
}

function nextRepeat(node: RegexNode, repeat: number): number | null {
  if (node.quant.max === null) {
    return 1;
  }
  if (repeat < node.quant.max) return repeat + 1;
  return null;
}

type ConsumingRegexNode = Extract<RegexNode, { kind: 'dot' | 'literal' | 'class' }>;

function isConsumingNode(node: RegexNode): node is ConsumingRegexNode {
  return node.kind === 'dot' || node.kind === 'literal' || node.kind === 'class';
}

// Every token with a positive minimum must occur in sequence in any successful
// match.  This cheap necessary-condition pass avoids retrying a long
// backtracking-shaped pattern at every start when one required atom is absent.
function requiredSequencePossible(
  line: string,
  nodes: readonly RegexNode[],
  caseSensitive: boolean,
): boolean {
  let cursor = 0;

  for (const node of nodes) {
    if (!isConsumingNode(node) || node.quant.min === 0) continue;
    for (let repeat = 0; repeat < node.quant.min; repeat += 1) {
      while (
        cursor < line.length &&
        !consumeMatches(node, sliceCodePoint(line, cursor), caseSensitive)
      ) {
        cursor += codePointWidth(line, cursor);
      }
      if (cursor >= line.length) return false;
      cursor += codePointWidth(line, cursor);
    }
  }

  return true;
}

// A match starting after the final occurrence of any mandatory atom is
// impossible.  The smallest such final position is a safe upper bound for
// candidate starts and prevents a no-match suffix from becoming quadratic.
function latestPossibleStart(
  line: string,
  nodes: readonly RegexNode[],
  caseSensitive: boolean,
): number | null {
  let latestStart: number | null = null;

  for (const node of nodes) {
    if (!isConsumingNode(node) || node.quant.min === 0) continue;
    let last = -1;
    for (let offset = 0; offset < line.length;) {
      const w = codePointWidth(line, offset);
      if (consumeMatches(node, line.slice(offset, offset + w), caseSensitive)) last = offset;
      offset += w;
    }
    if (last < 0) return -1;
    latestStart = latestStart === null ? last : Math.min(latestStart, last);
  }

  return latestStart;
}

// With a line-end anchor, the last visible code POINT must be consumed by one
// of the suffix tokens whose following tokens are all optional.  This is only
// a necessary condition, but rejects the classic `a+$` versus `aaaa!` long
// suffix without changing valid results.
function endAnchorCanMatchLineEnd(
  line: string,
  nodes: readonly RegexNode[],
  caseSensitive: boolean,
): boolean {
  if (line.length === 0) return true;
  // Last code point — not the trailing low surrogate of an astral char.
  let lastStart = 0;
  for (let o = 0; o < line.length;) {
    lastStart = o;
    o += codePointWidth(line, o);
  }
  const finalUnit = line.slice(lastStart);
  let suffixRequiresConsumption = false;
  let hasCandidate = false;

  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (!isConsumingNode(node)) continue;
    if (!suffixRequiresConsumption && node.quant.max !== 0) {
      hasCandidate = true;
      if (consumeMatches(node, finalUnit, caseSensitive)) return true;
    }
    if (node.quant.min > 0) suffixRequiresConsumption = true;
  }

  return !hasCandidate;
}

function containsEndAnchor(nodes: readonly RegexNode[]): boolean {
  for (const node of nodes) if (node.kind === 'end-anchor') return true;
  return false;
}

function containsStartAnchor(nodes: readonly RegexNode[]): boolean {
  for (const node of nodes) if (node.kind === 'start-anchor') return true;
  return false;
}

function containsAcceptState(states: readonly number[], acceptState: number): boolean {
  for (const state of states) if (state === acceptState) return true;
  return false;
}

function advanceVisitTag(seen: Uint32Array, visitTag: number): number {
  if (visitTag >= 0xffff_fffe) {
    seen.fill(0);
    return 1;
  }
  return visitTag + 1;
}

type RegexTables = ReturnType<typeof buildStateTables>;

function collectRegexMatches(
  line: string,
  nodes: readonly RegexNode[],
  caseSensitive: boolean,
  lineIndex: number,
  limitState: { limitReached: boolean; matches: SearchMatch[] },
  tables: RegexTables,
  seen: Uint32Array,
  transitionSeen: Uint32Array,
) {
  if (!requiredSequencePossible(line, nodes, caseSensitive)) return;
  if (containsEndAnchor(nodes) && !endAnchorCanMatchLineEnd(line, nodes, caseSensitive)) return;

  let visitTag = 1;
  let transitionTag = 1;
  // Reset visit tags for this line (arrays are reused across lines).
  seen.fill(0);
  transitionSeen.fill(0);
  const lineLen = line.length;
  const startUpperBound = latestPossibleStart(line, nodes, caseSensitive);
  const startAnchored = containsStartAnchor(nodes);
  let start = 0;

  // Search is non-overlapping within a line, matching the normal terminal
  // find UX.  For a given start retain the farthest accepted endpoint, so
  // unbounded quantifiers remain greedy without enumerating every endpoint.
  // Positions advance by whole code points so `.` / classes never split a
  // surrogate pair; spans remain UTF-16 offsets.
  while (start < lineLen && !limitState.limitReached) {
    if (startAnchored && start > 0) break;
    if (startUpperBound !== null && start > startUpperBound) break;

    const initialId = tables.firstStateForToken[0];
    let states = [initialId];
    let bestEnd = -1;

    let pos = start;
    while (pos <= lineLen) {
      states = epsilonClose(states, lineLen, pos, nodes, tables, seen, visitTag);
      visitTag = advanceVisitTag(seen, visitTag);

      if (pos > start && containsAcceptState(states, tables.acceptState)) {
        bestEnd = pos;
      }
      if (pos === lineLen || states.length === 0) break;

      const w = codePointWidth(line, pos);
      const ch = line.slice(pos, pos + w);
      const nextStates: number[] = [];
      for (let j = 0; j < states.length; j += 1) {
        const id = states[j];
        if (id === tables.acceptState) continue;
        const tokenIndex = tables.stateToken[id];
        const repeat = tables.stateRep[id];
        const node = nodes[tokenIndex];
        if (node.kind !== 'dot' && node.kind !== 'literal' && node.kind !== 'class') continue;
        if (!consumeMatches(node, ch, caseSensitive)) continue;
        const progressed = nextRepeat(node, repeat);
        if (progressed === null) continue;
        const nextId = tables.firstStateForToken[tokenIndex] + progressed;
        if (!Number.isFinite(nextId)) continue;
        if (transitionSeen[nextId] !== transitionTag) {
          transitionSeen[nextId] = transitionTag;
          nextStates.push(nextId);
        }
      }

      states = nextStates;
      if (states.length === 0) break;
      transitionTag = advanceVisitTag(transitionSeen, transitionTag);
      pos += w;
    }

    if (bestEnd > start) {
      if (limitState.matches.length >= MAX_MATCHES) {
        limitState.limitReached = true;
        break;
      }
      limitState.matches.push({ line: lineIndex, start, end: bestEnd });
      start = bestEnd;
    } else {
      start += codePointWidth(line, start);
    }
  }
}

function isPureAscii(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function collectPlainMatches(
  line: string,
  // Pre-folded needle when case-insensitive; original query when sensitive.
  // Caller hoists toLowerCase() once per searchLines call.
  needle: string,
  caseSensitive: boolean,
  lineIndex: number,
  limitState: { limitReached: boolean; matches: SearchMatch[] },
) {
  // Case-insensitive pure-ASCII: toLowerCase is index-preserving, so skip the
  // fold-index allocation that dominates the no-match hot path.
  if (!caseSensitive && isPureAscii(line)) {
    const haystack = line.toLowerCase();
    const queryLen = needle.length;
    let pos = 0;
    while (true) {
      if (limitState.limitReached) break;
      if (pos + queryLen > haystack.length) break;
      const found = haystack.indexOf(needle, pos);
      if (found < 0) break;
      if (limitState.matches.length >= MAX_MATCHES) {
        limitState.limitReached = true;
        break;
      }
      const end = found + queryLen;
      if (end > found) {
        limitState.matches.push({ line: lineIndex, start: found, end });
      }
      pos = found + 1;
    }
    return;
  }

  const folded = caseSensitive ? null : foldVisibleText(line);
  const haystack = caseSensitive ? line : folded!.text;
  const queryLen = needle.length;

  let pos = 0;
  while (true) {
    if (limitState.limitReached) break;
    if (pos + queryLen > haystack.length) break;
    const found = haystack.indexOf(needle, pos);
    if (found < 0) break;
    if (limitState.matches.length >= MAX_MATCHES) {
      limitState.limitReached = true;
      break;
    }
    const start = caseSensitive ? found : folded!.starts[found];
    const end = caseSensitive
      ? found + queryLen
      : folded!.ends[found + queryLen - 1];
    if (start !== undefined && end !== undefined && end > start) {
      limitState.matches.push({ line: lineIndex, start, end });
    }
    pos = found + 1;
  }
}

export function searchLines(
  rawLines: readonly string[],
  query: string,
  options?: SearchOptions,
): SearchResult {
  if (query.length === 0) {
    return {
      matches: [],
      error: createError('empty-query', 'query cannot be empty'),
    };
  }
  if (query.length > MAX_PATTERN_UNITS) {
    return {
      matches: [],
      error: createError('pattern-too-long', `query exceeds ${MAX_PATTERN_UNITS} UTF-16 units`),
    };
  }

  const mode = options?.mode ?? 'plain';
  const caseSensitive = options?.caseSensitive ?? false;
  const limitState: { limitReached: boolean; matches: SearchMatch[] } = {
    limitReached: false,
    matches: [],
  };

  if (mode === 'plain') {
    // Fold the needle once per searchLines call (not once per line).
    const needle = caseSensitive ? query : query.toLowerCase();
    for (let line = 0; line < rawLines.length; line += 1) {
      if (limitState.limitReached) break;
      const visible = stripTerminalControls(rawLines[line]);
      collectPlainMatches(visible, needle, caseSensitive, line, limitState);
    }
    return {
      matches: limitState.matches,
      error: limitState.limitReached
        ? createError('result-limit', 'too many matches')
        : null,
    };
  }

  if (mode !== 'regex-lite') {
    return {
      matches: [],
      error: createError('unsupported-syntax', 'unsupported search mode'),
    };
  }

  const parse = parseRegexLite(query);
  if (parse.error) {
    return { matches: [], error: parse.error };
  }

  // Pattern-dependent tables + scratch buffers: build once per searchLines call.
  const tables = buildStateTables(parse.nodes);
  const seen = new Uint32Array(tables.acceptState + 1);
  const transitionSeen = new Uint32Array(tables.acceptState + 1);

  for (let line = 0; line < rawLines.length; line += 1) {
    if (limitState.limitReached) break;
    const visible = stripTerminalControls(rawLines[line]);
    collectRegexMatches(
      visible,
      parse.nodes,
      caseSensitive,
      line,
      limitState,
      tables,
      seen,
      transitionSeen,
    );
  }

  return {
    matches: limitState.matches,
    error: limitState.limitReached
      ? createError('result-limit', 'too many matches')
      : null,
  };
}
