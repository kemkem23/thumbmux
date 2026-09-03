/** Visible terminal text after removing control sequences that paint no cells. */
const ESC = '\u001b';
const BEL = '\u0007';
const ST = '\\';

/**
 * True only for a terminal row that paints no semantic cell and contains no
 * control other than complete SGR paint. Detector seals and projection
 * coalescing share this single conservative definition.
 */
export function isBlankToolSeparator(raw: string): boolean {
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== ESC) {
      if (!/[ \t\u00a0]/u.test(raw[index] ?? '')) return false;
      index += 1;
      continue;
    }
    const next = raw[index + 1];
    // Only SGR paint is safe separator chrome. Cursor movement, erase/reset,
    // OSC, charset controls, and unfamiliar/incomplete ESC sequences stay raw.
    if (next !== '[') return false;
    let end = index + 2;
    while (end < raw.length && /[0-9:;]/u.test(raw[end] ?? '')) end += 1;
    if (raw[end] !== 'm') return false;
    index = end + 1;
  }
  return true;
}

function isSurrogatePairAt(text: string, index: number): boolean {
  if (index < 0 || index + 1 >= text.length) return false;
  const hi = text.charCodeAt(index);
  const lo = text.charCodeAt(index + 1);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
}

/**
 * Strip the same CSI, OSC, charset, and two-byte ESC controls consumed by the
 * ANSI renderer. Keeping this parser framework-independent lets cursor,
 * search, copy, prompt scanning, and link geometry share one visible stream.
 */
export function stripTerminalControls(raw: string): string {
  if (raw.indexOf(ESC) < 0) return raw;

  let out = '';
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== ESC) {
      out += raw[i];
      i += 1;
      continue;
    }
    if (i + 1 >= raw.length) break;

    const next = raw[i + 1];
    if (next === '[') {
      let end = i + 2;
      let abortedAt = -1;
      while (end < raw.length) {
        const code = raw.charCodeAt(end);
        if (code === 0x1b) {
          abortedAt = end;
          break;
        }
        if (code >= 0x40 && code <= 0x7e) break;
        end += 1;
      }
      if (abortedAt >= 0) {
        i = abortedAt;
        continue;
      }
      if (end >= raw.length) break;
      i = end + 1;
      continue;
    }

    if (next === ']') {
      let end = i + 2;
      let after = raw.length;
      let terminated = false;
      while (end < raw.length) {
        if (raw[end] === BEL) {
          after = end + 1;
          terminated = true;
          break;
        }
        if (raw[end] === ESC && end + 1 < raw.length && raw[end + 1] === ST) {
          after = end + 2;
          terminated = true;
          break;
        }
        end += 1;
      }
      if (!terminated) break;
      i = after;
      continue;
    }

    if (
      next === '(' || next === ')' || next === '*' || next === '+' ||
      next === '-' || next === '.' || next === '/' || next === '#' || next === '%'
    ) {
      const third = i + 2;
      if (
        third >= raw.length ||
        raw.charCodeAt(third) === 0x1b ||
        isSurrogatePairAt(raw, third)
      ) {
        i = Math.min(raw.length, third);
      } else {
        i = Math.min(raw.length, i + 3);
      }
      continue;
    }

    if (next === '=' || next === '>' || next === '7' || next === '8') {
      i += 2;
      continue;
    }

    // Unknown two-byte ESC controls (RIS, IND, NEL, save/restore variants,
    // etc.) consume their final byte just like lineToHtml.
    i += 2;
  }
  return out;
}
