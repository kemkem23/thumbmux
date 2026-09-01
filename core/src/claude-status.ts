/** Claude Code thinking-animation grammar and measured paint signature. */

import { stripTerminalControls } from './terminal-controls';

const CLAUDE_ACTIVITY_MARKER = '[●·✻✽✶✳✢*]';
const CLAUDE_STATUS_WORD = "\\p{L}[\\p{L}'’-]*";
const CLAUDE_ACTIVITY_DETAIL = '(?:\\bthinking\\b|\\beffort\\b|\\btokens?\\b)';

// Tool output can naturally say `Reading app.log`, `Writing a report`, or
// `Done for 3m`. Do not classify those semantic words alone. Current Claude
// thinking frames carry a one-word animated verb plus a parenthetical detail
// containing activity metadata; requiring both keeps ambiguous shell text raw.
const CLAUDE_ACTIVE_STATUS = new RegExp(
  `^${CLAUDE_ACTIVITY_MARKER}\\s+${CLAUDE_STATUS_WORD}(?:…|\\.{3})\\s+`
    + `\\((?=[^\\n)]*${CLAUDE_ACTIVITY_DETAIL})[^\\n)]*\\)\\s*$`,
  'iu',
);

const CLAUDE_STATUS_PAINT_PARTS = new RegExp(
  `^(${CLAUDE_ACTIVITY_MARKER})\\s+(${CLAUDE_STATUS_WORD}(?:…|\\.{3}))\\s+\\(`,
  'u',
);

export function isClaudeActivityStatusLine(line: string): boolean {
  const normalized = line.replace(/\u00a0/g, ' ').trim();
  if (normalized.length === 0 || normalized.length > 4_096) return false;
  return CLAUDE_ACTIVE_STATUS.test(normalized);
}

type PaintSgrState = {
  foreground: number | null;
  inverse: boolean;
  concealed: boolean;
};

function strictUnsigned(value: string | undefined, emptyIsZero = false): number | null {
  if (value === undefined) return null;
  if (value === '') return emptyIsZero ? 0 : null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validRgb(parts: readonly (string | undefined)[]): boolean {
  return parts.length === 3 && parts.every((part) => strictUnsigned(part) !== null);
}

function applyPaintSgr(parameters: string, state: PaintSgrState): PaintSgrState {
  if (parameters === '') {
    return { foreground: null, inverse: false, concealed: false };
  }
  const fields = parameters.split(';');
  let next = { ...state };
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? '';
    const colon = field.split(':');
    // Match the renderer's strict unsigned grammar. Whitespace, signs and
    // decimals are CSI intermediates/invalid parameters, not numeric aliases.
    const value = strictUnsigned(colon[0], field === '');
    if (value === null) continue;
    if (value === 0) {
      next = { foreground: null, inverse: false, concealed: false };
      continue;
    }
    if (value === 39) {
      next.foreground = null;
      continue;
    }
    if (value === 7) {
      next.inverse = true;
      continue;
    }
    if (value === 27) {
      next.inverse = false;
      continue;
    }
    if (value === 8) {
      next.concealed = true;
      continue;
    }
    if (value === 28) {
      next.concealed = false;
      continue;
    }
    if (value === 38 || value === 48 || value === 58) {
      // ISO-8613 colon form keeps every extended-colour operand inside one
      // field. RGB components which happen to be 7/27/38 are data, not SGR.
      if (colon.length > 1) {
        const mode = strictUnsigned(colon[1], true);
        if (value === 38 && mode === 5) {
          const paletteIndex = strictUnsigned(colon[2]);
          if (paletteIndex !== null && paletteIndex <= 255) {
            next.foreground = paletteIndex;
          }
        } else if (value === 38 && mode === 2) {
          const componentStart = colon.length >= 6 ? 3 : 2;
          if (validRgb(colon.slice(componentStart, componentStart + 3))) {
            next.foreground = -1;
          }
        }
        continue;
      }

      const mode = strictUnsigned(fields[index + 1], true);
      if (mode === 5) {
        const consumed = Math.min(2, fields.length - index - 1);
        const paletteIndex = strictUnsigned(fields[index + 2]);
        if (value === 38) {
          if (paletteIndex !== null && paletteIndex <= 255) {
            next.foreground = paletteIndex;
          }
        }
        index += consumed;
        continue;
      }
      if (mode === 2) {
        const consumed = Math.min(4, fields.length - index - 1);
        if (
          value === 38
          && fields[index + 4] !== undefined
          && validRgb(fields.slice(index + 2, index + 5))
        ) next.foreground = -1;
        index += consumed;
        continue;
      }
      continue;
    }
    // A basic/bright foreground supersedes a prior indexed foreground. Its
    // exact palette value is irrelevant because it is not a measured Claude
    // activity colour.
    if ((value >= 30 && value <= 37) || (value >= 90 && value <= 97)) {
      next.foreground = -1;
    }
  }
  return next;
}

type TerminalPaintSnapshot = Readonly<{
  visible: string;
  foregrounds: readonly (number | null)[];
  endForeground: number | null;
  endInverse: boolean;
  endConcealed: boolean;
}>;

/** Visible UTF-16 stream plus the indexed foreground active on every unit. */
export function terminalPaintSnapshot(
  raw: string,
  initialForeground: number | null = null,
  initialInverse = false,
  initialConcealed = false,
): TerminalPaintSnapshot | null {
  let paintState: PaintSgrState = {
    foreground: initialForeground,
    inverse: initialInverse,
    concealed: initialConcealed,
  };
  let visible = '';
  const foregrounds: (number | null)[] = [];
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== '\x1b') {
      const codePoint = raw.codePointAt(index);
      if (codePoint === undefined) break;
      const painted = String.fromCodePoint(codePoint);
      visible += painted;
      const effectiveForeground = paintState.inverse || paintState.concealed
        ? -1
        : paintState.foreground;
      for (let unit = 0; unit < painted.length; unit += 1) {
        foregrounds.push(effectiveForeground);
      }
      index += painted.length;
      continue;
    }

    if (raw[index + 1] === '[') {
      let end = index + 2;
      while (end < raw.length) {
        const code = raw.charCodeAt(end);
        // ESC aborts an unfinished CSI and starts a fresh control sequence in
        // the renderer. This bounded paint parser does not borrow state across
        // that ambiguous restart; the caller keeps the raw rows instead.
        if (code === 0x1b) return null;
        if (code >= 0x40 && code <= 0x7e) break;
        end += 1;
      }
      if (end >= raw.length) return null;
      if (raw[end] === 'm') {
        paintState = applyPaintSgr(raw.slice(index + 2, end), paintState);
      }
      index = end + 1;
      continue;
    }

    if (raw[index + 1] === ']') {
      let end = index + 2;
      let terminated = false;
      while (end < raw.length) {
        if (raw[end] === '\x07') {
          index = end + 1;
          terminated = true;
          break;
        }
        if (raw[end] === '\x1b' && raw[end + 1] === '\\') {
          index = end + 2;
          terminated = true;
          break;
        }
        end += 1;
      }
      if (!terminated) return null;
      continue;
    }

    // Charset designators and other two/three-byte ESC controls do not paint
    // cells. The shared stripper performs the final semantic validation.
    const next = raw[index + 1];
    if (next === '\x1b') return null;
    if (
      next
      && '()*+-./#%'.includes(next)
      && raw[index + 2] === '\x1b'
    ) return null;
    if (next === 'c') {
      paintState = { foreground: null, inverse: false, concealed: false };
    }
    index += next && '()*+-./#%'.includes(next) ? 3 : 2;
  }
  // This parser deliberately supports only the measured paint subset needed
  // by Claude chrome. If an ESC abort/restart or another control sequence is
  // consumed differently from the canonical terminal-control stripper, its
  // carry state is not trustworthy. Fail open instead of lending that state
  // to the next physical row.
  if (visible !== stripTerminalControls(raw)) return null;
  return {
    visible,
    foregrounds,
    endForeground: paintState.foreground,
    endInverse: paintState.inverse,
    endConcealed: paintState.concealed,
  };
}

/**
 * Require one measured Claude paint layout on semantic cells. Current Claude
 * uses marker/animated verb 174 plus activity metadata 246. Older captures use
 * a 246 marker followed by default-colour verb/metadata. tmux may split/reset
 * SGR spans at any cell boundary, so validation follows resulting foreground
 * state instead of matching one byte-for-byte escape layout.
 */
export function isStyledClaudeActivityStatusLine(
  raw: string,
  initialForeground: number | null = null,
  initialInverse = false,
  initialConcealed = false,
): boolean {
  if (raw.length === 0 || raw.length > 65_536) return false;
  const paint = terminalPaintSnapshot(
    raw,
    initialForeground,
    initialInverse,
    initialConcealed,
  );
  if (!paint) return false;
  const visible = paint.visible.replace(/\u00a0/g, ' ');
  if (visible !== visible.trimStart()) return false;
  const normalized = visible.trimEnd();
  if (!isClaudeActivityStatusLine(normalized)) return false;
  const parts = CLAUDE_STATUS_PAINT_PARTS.exec(normalized);
  const marker = parts?.[1];
  const verb = parts?.[2];
  if (!marker || !verb) return false;
  const verbStart = normalized.indexOf(verb, marker.length);
  const metadataStart = normalized.indexOf('(', verbStart + verb.length);
  const metadataEnd = normalized.lastIndexOf(')');
  if (verbStart < 0 || metadataStart < 0 || metadataEnd <= metadataStart) return false;

  const paintedAs = (start: number, end: number, expected: number | null): boolean => {
    for (let unit = start; unit < end; unit += 1) {
      if (/\s/u.test(normalized[unit] ?? '')) continue;
      if (paint.foregrounds[unit] !== expected) return false;
    }
    return true;
  };
  const currentPaint = paintedAs(0, marker.length, 174)
    && paintedAs(verbStart, verbStart + verb.length, 174)
    && paintedAs(metadataStart, metadataEnd + 1, 246);
  const legacyPaint = paintedAs(0, marker.length, 246)
    && paintedAs(verbStart, verbStart + verb.length, null)
    && paintedAs(metadataStart, metadataEnd + 1, null);
  return currentPaint || legacyPaint;
}
