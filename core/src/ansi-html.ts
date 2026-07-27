/**
 * Minimal SGR (ANSI color) → HTML renderer for the mobile terminal engine.
 *
 * tmux `capture-pane -e` output is plain text lines with inline SGR codes —
 * no cursor movement — so a color-state machine over `ESC[...m` is enough.
 * SGR and OSC 8 state legally carry across lines, so callers thread state:
 *
 *   const st = createSgrState();
 *   for (const line of lines) html.push(lineToHtml(line, st, palette));
 *
 * Used by MobileTermView: lines render once into DOM and scrolling is a pure
 * GPU transform, so this parser is OFF the scroll hot path by design.
 */

export type UnderlineStyle = 'single' | 'double' | 'curly' | 'dotted' | 'dashed';

export type SgrState = {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  /** Retained for existing callers; it mirrors `underlineStyle !== null`. */
  underline: boolean;
  /**
   * Optional for back-compat with v0.3.5 object literals (8 fields only).
   * Missing values are treated as `null` at read sites — createSgrState still
   * always materialises all three modern fields.
   */
  underlineStyle?: UnderlineStyle | null;
  underlineColor?: string | null;
  inverse: boolean;
  strike: boolean;
  /** A validated active OSC 8 href, carried until an OSC 8 close. */
  osc8Href?: string | null;
};

export type AnsiPalette = {
  /** indexes 0-15; 16-255 computed */
  base: string[];
  defaultFg: string;
  defaultBg: string;
};

export type LineLinkRange = { start: number; end: number; href: string };
export type LineOverlayRange = {
  start: number;
  end: number;
  kind: 'search-match' | 'search-active';
};

const BEL = '\u0007';
const ESC = '\u001b';
const ST = '\\';

export function createSgrState(): SgrState {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    underlineStyle: null,
    underlineColor: null,
    inverse: false,
    strike: false,
    osc8Href: null,
  };
}

export function cloneSgrState(s: SgrState): SgrState {
  // Normalise optional modern fields so clones always carry the full runtime
  // shape that createSgrState produces — without mutating the caller's object.
  return {
    fg: s.fg,
    bg: s.bg,
    bold: s.bold,
    dim: s.dim,
    italic: s.italic,
    underline: s.underline,
    underlineStyle: s.underlineStyle ?? null,
    underlineColor: s.underlineColor ?? null,
    inverse: s.inverse,
    strike: s.strike,
    osc8Href: s.osc8Href ?? null,
  };
}

export function sgrStateKey(s: SgrState): string {
  return [
    s.fg ?? '',
    s.bg ?? '',
    +s.bold,
    +s.dim,
    +s.italic,
    +s.underline,
    s.underlineStyle ?? '',
    s.underlineColor ?? '',
    +s.inverse,
    +s.strike,
    s.osc8Href ?? '',
  ].join('|');
}

function xterm256(n: number): string {
  if (n < 16) return ''; // handled via palette.base
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    const h = v.toString(16).padStart(2, '0');
    return `#${h}${h}${h}`;
  }
  const idx = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  const r = steps[Math.floor(idx / 36) % 6]!;
  const g = steps[Math.floor(idx / 6) % 6]!;
  const b = steps[idx % 6]!;
  const h = (v: number) => v.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function colorFor(palette: AnsiPalette, spec: string | null): string | null {
  if (spec === null) return null;
  if (/^#[0-9a-f]{6}$/i.test(spec)) return spec;
  if (!/^\d+$/.test(spec)) return null;
  const n = Number(spec);
  if (!Number.isSafeInteger(n) || n < 0 || n > 255) return null;
  if (n < 16) return palette.base[n] ?? null;
  return xterm256(n);
}

function parseUnsigned(value: string | undefined, emptyIsZero = false): number | null {
  if (value === undefined) return null;
  if (value === '') return emptyIsZero ? 0 : null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function rgbColor(r: string | undefined, g: string | undefined, b: string | undefined): string | null {
  const values = [parseUnsigned(r), parseUnsigned(g), parseUnsigned(b)];
  if (values.some((value) => value === null)) return null;
  return `#${values.map((value) => clampByte(value!).toString(16).padStart(2, '0')).join('')}`;
}

function indexedColor(value: string | undefined): string | null {
  const index = parseUnsigned(value);
  return index !== null && index <= 255 ? String(index) : null;
}

function colorFromColon(parts: string[]): string | null {
  const mode = parseUnsigned(parts[1], true);
  if (mode === 5) return indexedColor(parts[2]);
  if (mode !== 2) return null;

  // ECMA colon form may include an empty/numeric colorspace field:
  // `58:2::r:g:b` or `58:2:space:r:g:b`.  The compact form omits it.
  const componentStart = parts.length >= 6 ? 3 : 2;
  return rgbColor(parts[componentStart], parts[componentStart + 1], parts[componentStart + 2]);
}

function colorFromSemicolon(fields: string[], at: number): { color: string | null; consumed: number } {
  const mode = parseUnsigned(fields[at + 1], true);
  if (mode === 5) {
    const consumed = Math.min(2, fields.length - at - 1);
    return {
      color: fields[at + 2] === undefined ? null : indexedColor(fields[at + 2]),
      consumed,
    };
  }
  if (mode === 2) {
    const consumed = Math.min(4, fields.length - at - 1);
    return {
      color: fields[at + 4] === undefined
        ? null
        : rgbColor(fields[at + 2], fields[at + 3], fields[at + 4]),
      consumed,
    };
  }
  return { color: null, consumed: 0 };
}

function resetSgr(st: SgrState): void {
  st.fg = null;
  st.bg = null;
  st.bold = false;
  st.dim = false;
  st.italic = false;
  st.underline = false;
  st.underlineStyle = null;
  st.underlineColor = null;
  st.inverse = false;
  st.strike = false;
}

function setUnderline(st: SgrState, style: UnderlineStyle | null): void {
  st.underline = style !== null;
  st.underlineStyle = style;
}

function applyUnderlineVariant(st: SgrState, code: number | null): void {
  switch (code) {
    case 0:
      setUnderline(st, null);
      break;
    case 1:
      setUnderline(st, 'single');
      break;
    case 2:
      setUnderline(st, 'double');
      break;
    case 3:
      setUnderline(st, 'curly');
      break;
    case 4:
      setUnderline(st, 'dotted');
      break;
    case 5:
      setUnderline(st, 'dashed');
      break;
    default:
      break;
  }
}

function applySgrParams(raw: string, st: SgrState): void {
  const fields = raw === '' ? ['0'] : raw.split(';');

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!;
    const colon = field.split(':');
    const code = parseUnsigned(colon[0], field === '');
    if (code === null) continue;

    if (code === 4 && colon.length > 1) {
      applyUnderlineVariant(st, parseUnsigned(colon[1], true));
      continue;
    }

    switch (code) {
      case 0:
        // OSC 8 is independent terminal state: SGR reset must not close it.
        resetSgr(st);
        break;
      case 1:
        st.bold = true;
        break;
      case 2:
        st.dim = true;
        break;
      case 3:
        st.italic = true;
        break;
      case 4:
        setUnderline(st, 'single');
        break;
      case 7:
        st.inverse = true;
        break;
      case 9:
        st.strike = true;
        break;
      case 21:
        setUnderline(st, 'double');
        break;
      case 22:
        st.bold = false;
        st.dim = false;
        break;
      case 23:
        st.italic = false;
        break;
      case 24:
        setUnderline(st, null);
        break;
      case 27:
        st.inverse = false;
        break;
      case 29:
        st.strike = false;
        break;
      case 38:
      case 48:
      case 58: {
        const color = colon.length > 1
          ? colorFromColon(colon)
          : (() => {
              const parsed = colorFromSemicolon(fields, i);
              i += parsed.consumed;
              return parsed.color;
            })();
        if (color === null) break;
        if (code === 38) st.fg = color;
        else if (code === 48) st.bg = color;
        else st.underlineColor = color;
        break;
      }
      case 39:
        st.fg = null;
        break;
      case 49:
        st.bg = null;
        break;
      case 59:
        st.underlineColor = null;
        break;
      default:
        if (code >= 30 && code <= 37) st.fg = String(code - 30);
        else if (code >= 90 && code <= 97) st.fg = String(code - 90 + 8);
        else if (code >= 40 && code <= 47) st.bg = String(code - 40);
        else if (code >= 100 && code <= 107) st.bg = String(code - 100 + 8);
        break;
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isSafeHref(rawHref: string): string | null {
  if (rawHref === '' || rawHref !== rawHref.trim() || /[\u0000-\u001f\u007f]/.test(rawHref)) return null;
  try {
    const protocol = new URL(rawHref).protocol.toLowerCase();
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:' ? rawHref : null;
  } catch {
    return null;
  }
}

function applyOscPayload(payload: string, st: SgrState): void {
  if (!payload.startsWith('8;')) return;
  const firstSeparator = payload.indexOf(';');
  const secondSeparator = payload.indexOf(';', firstSeparator + 1);
  // A malformed OSC 8 must not leave a prior safe link active.
  if (secondSeparator === -1) {
    st.osc8Href = null;
    return;
  }
  st.osc8Href = isSafeHref(payload.slice(secondSeparator + 1));
}

function isDefaultSgrState(st: SgrState): boolean {
  return (
    st.fg === null &&
    st.bg === null &&
    !st.bold &&
    !st.dim &&
    !st.italic &&
    !st.underline &&
    // Missing modern fields (legacy 8-field literals) count as null.
    (st.underlineStyle ?? null) === null &&
    (st.underlineColor ?? null) === null &&
    !st.inverse &&
    !st.strike
  );
}

function styleDeclarations(st: SgrState, palette: AnsiPalette, linkUnderline = false): string[] {
  let fg = colorFor(palette, st.fg) ?? palette.defaultFg;
  let bg = colorFor(palette, st.bg);
  if (st.inverse) {
    const realBg = bg ?? palette.defaultBg;
    bg = fg;
    fg = realBg;
  }
  if (st.bold && st.fg !== null) {
    const n = Number(st.fg);
    if (Number.isFinite(n) && n >= 0 && n < 8) fg = colorFor(palette, String(n + 8)) ?? fg;
  }

  const styles: string[] = [`color:${fg}`];
  if (bg) styles.push(`background-color:${bg}`);
  if (st.bold) styles.push('font-weight:700');
  if (st.dim) styles.push('opacity:.6');
  if (st.italic) styles.push('font-style:italic');

  const decoration: string[] = [];
  if (st.underline || linkUnderline) decoration.push('underline');
  if (st.strike) decoration.push('line-through');
  if (decoration.length) styles.push(`text-decoration:${decoration.join(' ')}`);

  if (st.underline) {
    const underlineStyle = st.underlineStyle ?? null;
    if (underlineStyle === 'double') styles.push('text-decoration-style:double');
    else if (underlineStyle === 'dotted') styles.push('text-decoration-style:dotted');
    else if (underlineStyle === 'dashed') styles.push('text-decoration-style:dashed');
    else if (underlineStyle === 'curly') styles.push('text-decoration-style:wavy');

    const underlineColor = colorFor(palette, st.underlineColor ?? null);
    if (underlineColor) styles.push(`text-decoration-color:${underlineColor}`);
  }

  return styles;
}

function spanOpen(st: SgrState, palette: AnsiPalette): string {
  return `<span style="${styleDeclarations(st, palette).join(';')}">`;
}

function anchorOpen(st: SgrState, palette: AnsiPalette, href: string): string {
  const attrs = `href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer"`;
  if (isDefaultSgrState(st)) {
    return `<a ${attrs} style="color:inherit;text-decoration:underline">`;
  }
  return `<a ${attrs} style="${styleDeclarations(st, palette, true).join(';')}">`;
}

function isUsableRange(range: { start: number; end: number }): boolean {
  return (
    Number.isSafeInteger(range.start) &&
    Number.isSafeInteger(range.end) &&
    range.start >= 0 &&
    range.end > range.start
  );
}

/**
 * Sorted, advancing-index walker over pre-filtered link/overlay ranges.
 *
 * Replaces the prior O(ranges) rescan of nextRangeBoundary / overlayAt /
 * detectedHrefAt at every segment boundary (which was O(N²) for dense search
 * overlays). Positions are assumed non-decreasing within a single lineToHtml
 * call — which matches how appendText walks `col + offset`.
 *
 * Semantics preserved:
 *   - links: first covering range in original input order wins
 *   - overlays: any search-active covering wins over any search-match
 */
type IndexedLink = LineLinkRange & { ord: number };
type IndexedOverlay = LineOverlayRange & { ord: number };

function compareRangeStart(a: { start: number; ord: number }, b: { start: number; ord: number }): number {
  return a.start - b.start || a.ord - b.ord;
}

function buildRangeWalker(links: LineLinkRange[], overlays: LineOverlayRange[]) {
  const linksByStart: IndexedLink[] = links.map((link, ord) => ({
    start: link.start,
    end: link.end,
    href: link.href,
    ord,
  }));
  linksByStart.sort(compareRangeStart);

  const overlaysByStart: IndexedOverlay[] = overlays.map((overlay, ord) => ({
    start: overlay.start,
    end: overlay.end,
    kind: overlay.kind,
    ord,
  }));
  overlaysByStart.sort(compareRangeStart);

  // Unique sorted boundaries for O(1) amortized nextBoundary.
  const bounds: number[] = [];
  for (const link of linksByStart) {
    bounds.push(link.start, link.end);
  }
  for (const overlay of overlaysByStart) {
    bounds.push(overlay.start, overlay.end);
  }
  bounds.sort((a, b) => a - b);
  let boundLen = 0;
  for (let i = 0; i < bounds.length; i += 1) {
    const value = bounds[i]!;
    if (boundLen === 0 || bounds[boundLen - 1] !== value) {
      bounds[boundLen] = value;
      boundLen += 1;
    }
  }
  bounds.length = boundLen;

  let boundIdx = 0;
  let linkStartIdx = 0;
  let overlayStartIdx = 0;
  const activeLinks: IndexedLink[] = [];
  const activeOverlays: IndexedOverlay[] = [];
  let syncedAt = -1;

  const syncActive = (position: number): void => {
    if (position === syncedAt) return;
    // Positions only advance; drop ranges that have ended.
    let w = 0;
    for (let r = 0; r < activeLinks.length; r += 1) {
      if (activeLinks[r]!.end > position) activeLinks[w++] = activeLinks[r]!;
    }
    activeLinks.length = w;
    w = 0;
    for (let r = 0; r < activeOverlays.length; r += 1) {
      if (activeOverlays[r]!.end > position) activeOverlays[w++] = activeOverlays[r]!;
    }
    activeOverlays.length = w;

    while (linkStartIdx < linksByStart.length && linksByStart[linkStartIdx]!.start <= position) {
      const link = linksByStart[linkStartIdx++]!;
      if (link.end > position) activeLinks.push(link);
    }
    while (
      overlayStartIdx < overlaysByStart.length &&
      overlaysByStart[overlayStartIdx]!.start <= position
    ) {
      const overlay = overlaysByStart[overlayStartIdx++]!;
      if (overlay.end > position) activeOverlays.push(overlay);
    }
    syncedAt = position;
  };

  return {
    nextBoundary(position: number): number {
      while (boundIdx < bounds.length && bounds[boundIdx]! <= position) boundIdx += 1;
      return boundIdx < bounds.length ? bounds[boundIdx]! : Infinity;
    },
    hrefAt(position: number): string | null {
      syncActive(position);
      if (activeLinks.length === 0) return null;
      // Original input order: lowest ord among covering links.
      let best = activeLinks[0]!;
      for (let i = 1; i < activeLinks.length; i += 1) {
        const candidate = activeLinks[i]!;
        if (candidate.ord < best.ord) best = candidate;
      }
      return best.href;
    },
    overlayAt(position: number): 'search-match' | 'search-active' | null {
      syncActive(position);
      let hasMatch = false;
      for (let i = 0; i < activeOverlays.length; i += 1) {
        const kind = activeOverlays[i]!.kind;
        if (kind === 'search-active') return 'search-active';
        if (kind === 'search-match') hasMatch = true;
      }
      return hasMatch ? 'search-match' : null;
    },
  };
}

/** True when `index` is a high surrogate followed by a low surrogate in `text`. */
function isSurrogatePairAt(text: string, index: number): boolean {
  if (index < 0 || index + 1 >= text.length) return false;
  const hi = text.charCodeAt(index);
  const lo = text.charCodeAt(index + 1);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
}

function withOverlay(text: string, kind: 'search-match' | 'search-active' | null): string {
  const escaped = escapeHtml(text);
  if (kind === 'search-active') return `<span class="search-active">${escaped}</span>`;
  if (kind === 'search-match') return `<span class="search-match">${escaped}</span>`;
  return escaped;
}

/**
 * Render one line to HTML, mutating `st` to the state AFTER the line.
 * Default-state runs are emitted bare (no span) to keep the DOM light.
 */
export function lineToHtml(
  line: string,
  st: SgrState,
  palette: AnsiPalette,
  links?: LineLinkRange[],
  overlays?: LineOverlayRange[],
): string {
  let out = '';
  let col = 0; // visible UTF-16 code-unit cursor

  // Validate range inputs once per call — not per character position.
  const usableLinks: LineLinkRange[] = [];
  if (links?.length) {
    for (const link of links) {
      if (!isUsableRange(link)) continue;
      const href = isSafeHref(link.href);
      if (!href) continue;
      usableLinks.push({ start: link.start, end: link.end, href });
    }
  }
  const usableOverlays: LineOverlayRange[] = [];
  if (overlays?.length) {
    for (const overlay of overlays) {
      if (!isUsableRange(overlay)) continue;
      if (overlay.kind !== 'search-match' && overlay.kind !== 'search-active') continue;
      usableOverlays.push(overlay);
    }
  }

  // Sort once + advancing indices for O(N + segments) overlay/link attribution.
  const rangeWalker =
    usableLinks.length > 0 || usableOverlays.length > 0
      ? buildRangeWalker(usableLinks, usableOverlays)
      : null;

  // OSC 8 href can change mid-line; memoize validation by raw value.
  let memoOsc8Raw: string | null | undefined = undefined;
  let memoOsc8Safe: string | null = null;
  const safeOsc8Href = (): string | null => {
    const raw = st.osc8Href ?? null;
    if (raw === memoOsc8Raw) return memoOsc8Safe;
    memoOsc8Raw = raw;
    memoOsc8Safe = raw ? isSafeHref(raw) : null;
    return memoOsc8Safe;
  };

  const appendText = (rawText: string): void => {
    if (!rawText) return;

    const explicitHref = safeOsc8Href();
    if (!explicitHref && !rangeWalker) {
      out += isDefaultSgrState(st)
        ? escapeHtml(rawText)
        : `${spanOpen(st, palette)}${escapeHtml(rawText)}</span>`;
      col += rawText.length;
      return;
    }

    let offset = 0;
    while (offset < rawText.length) {
      const absolute = col + offset;
      const boundary = rangeWalker ? rangeWalker.nextBoundary(absolute) : Infinity;
      const take = boundary === Infinity
        ? rawText.length - offset
        : Math.min(rawText.length - offset, boundary - absolute);
      // Boundaries are strictly after `absolute`; defensive fallback prevents a
      // hostile runtime range object from creating a zero-length loop.
      let count = take > 0 ? take : 1;
      // Never split a UTF-16 surrogate pair across segments.
      // If this segment would end on a high surrogate whose low half follows:
      //   - count > 1: leave the whole pair for the next segment (shrink), so
      //     the pair can start a segment of its own;
      //   - count == 1: absorb the low half (extend). Attribution of the
      //     segment that *starts* the pair wins; if that position has no
      //     link/overlay, fall through to the low half's range (a range that
      //     only covers the low half still wraps the whole emoji).
      if (
        offset + count < rawText.length &&
        isSurrogatePairAt(rawText, offset + count - 1)
      ) {
        if (count > 1) count -= 1;
        else count += 1;
      }
      let href = explicitHref ?? (rangeWalker ? rangeWalker.hrefAt(absolute) : null);
      let overlayKind = rangeWalker ? rangeWalker.overlayAt(absolute) : null;
      if (
        !explicitHref &&
        count >= 2 &&
        isSurrogatePairAt(rawText, offset)
      ) {
        if (!href && rangeWalker) href = rangeWalker.hrefAt(absolute + 1);
        if (!overlayKind && rangeWalker) overlayKind = rangeWalker.overlayAt(absolute + 1);
      }
      const contents = withOverlay(
        rawText.slice(offset, offset + count),
        overlayKind,
      );

      if (href) out += `${anchorOpen(st, palette, href)}${contents}</a>`;
      else if (isDefaultSgrState(st)) out += contents;
      else out += `${spanOpen(st, palette)}${contents}</span>`;
      offset += count;
    }
    col += rawText.length;
  };

  let cursor = 0;
  let textStart = 0;
  while (cursor < line.length) {
    if (line[cursor] !== ESC) {
      cursor += 1;
      continue;
    }

    appendText(line.slice(textStart, cursor));
    const next = line[cursor + 1];
    if (next === undefined) {
      cursor = line.length;
      textStart = cursor;
      break;
    }

    if (next === '[') {
      let end = cursor + 2;
      let aborted = false;
      while (end < line.length) {
        const code = line.charCodeAt(end);
        // ESC aborts an unfinished CSI; resume scanning at that ESC.
        if (code === 0x1b) {
          aborted = true;
          break;
        }
        if (code >= 0x40 && code <= 0x7e) break;
        end += 1;
      }
      if (aborted) {
        cursor = end;
        textStart = cursor;
        continue;
      }
      if (end >= line.length) {
        cursor = line.length;
        textStart = cursor;
        break;
      }
      if (line[end] === 'm') applySgrParams(line.slice(cursor + 2, end), st);
      cursor = end + 1;
      textStart = cursor;
      continue;
    }

    if (next === ']') {
      let end = cursor + 2;
      let after = line.length;
      let terminated = false;
      while (end < line.length) {
        if (line[end] === BEL) {
          applyOscPayload(line.slice(cursor + 2, end), st);
          after = end + 1;
          terminated = true;
          break;
        }
        if (line[end] === ESC && line[end + 1] === ST) {
          applyOscPayload(line.slice(cursor + 2, end), st);
          after = end + 2;
          terminated = true;
          break;
        }
        end += 1;
      }
      if (!terminated && line.slice(cursor + 2).startsWith('8;')) st.osc8Href = null;
      cursor = after;
      textStart = cursor;
      continue;
    }

    // Two-byte controls and character-set selectors have no visible output.
    // Charset selectors take a third byte; every other unknown ESC+byte pair
    // is consumed silently (must not print the second byte as text).
    // Never swallow the high half of a valid UTF-16 surrogate pair — stop
    // the skip before that unit so the whole astral character renders as text.
    // ESC also restarts the parser: stop the skip before any unit that is
    // itself ESC so a following CSI/OSC/escape is re-scanned, not eaten.
    if (next === '(' || next === ')' || next === '*' || next === '+' || next === '-' || next === '.' || next === '/' || next === '#' || next === '%') {
      const third = cursor + 2;
      if (
        third >= line.length ||
        line.charCodeAt(third) === 0x1b ||
        isSurrogatePairAt(line, third)
      ) {
        cursor = Math.min(line.length, third);
      } else {
        cursor = Math.min(line.length, cursor + 3);
      }
    } else if (
      line.charCodeAt(cursor + 1) === 0x1b ||
      isSurrogatePairAt(line, cursor + 1)
    ) {
      cursor += 1;
    } else {
      cursor += 2;
    }
    textStart = cursor;
  }

  if (textStart < line.length) appendText(line.slice(textStart));
  return out || '\u00a0';
}
