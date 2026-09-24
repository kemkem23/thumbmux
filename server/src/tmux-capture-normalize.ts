import { charCellWidth, stringCells } from '@thumbmux/core';

const ESC = 0x1b;
const BEL = 0x07;
const SO = 0x0e;
const SI = 0x0f;
const VS16 = 0xfe0f;

function escapeEnd(text: string, start: number): number {
  const introducer = text.charCodeAt(start + 1);
  if (introducer === 0x5b) {
    // CSI: consume through the first final byte (0x40..0x7e).
    for (let index = start + 2; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index + 1;
    }
    return text.length;
  }
  if (introducer === 0x5d) {
    // OSC: BEL or ST terminates the payload.
    for (let index = start + 2; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === BEL) return index + 1;
      if (code === ESC && text.charCodeAt(index + 1) === 0x5c) return index + 2;
    }
    return text.length;
  }
  return Math.min(text.length, start + 2);
}

/**
 * tmux 3.4 serializes a narrow base promoted by VS16 as the grapheme followed
 * by one ASCII continuation cell. For example, a pane containing `A❤️B` is
 * returned by `capture-pane` as `A❤️ B`; an intentional space becomes two.
 * CJK and intrinsically-wide emoji do not receive that extra byte.
 *
 * Thumbmux already renders the promoted unit as a two-cell `.mtv-w2` box, so
 * retaining tmux's continuation byte makes the following glyph and cursor one
 * cell too far right. Remove exactly one such byte while preserving ANSI/OSC
 * sequences and every intentional additional space.
 */
export function normalizeTmuxCaptureCells(text: string): string {
  let normalized = '';
  let index = 0;
  let previousVisibleWidth: 0 | 1 | 2 = 0;
  let promotedPaddingPending = false;

  while (index < text.length) {
    const codePoint = text.codePointAt(index)!;
    const unitLength = codePoint > 0xffff ? 2 : 1;

    if (codePoint === ESC) {
      const end = escapeEnd(text, index);
      normalized += text.slice(index, end);
      index = end;
      continue;
    }
    if (codePoint === 0x0a) {
      normalized += '\n';
      index += 1;
      previousVisibleWidth = 0;
      promotedPaddingPending = false;
      continue;
    }
    if (codePoint === SO || codePoint === SI) {
      // Shift Out/In changes the active terminal character set but occupies
      // no cell. tmux normally consumes it before capture-pane serialization;
      // preserve the byte without losing a still-pending continuation cell if
      // an alternate capture mode or tmux version does surface it.
      normalized += text.slice(index, index + unitLength);
      index += unitLength;
      continue;
    }

    const width = codePoint >= 0x20 && codePoint < 0x7f ? 1 : charCellWidth(codePoint);
    if (promotedPaddingPending && codePoint === 0x20) {
      promotedPaddingPending = false;
      index += 1;
      continue;
    }
    if (promotedPaddingPending && width > 0) promotedPaddingPending = false;

    normalized += text.slice(index, index + unitLength);
    index += unitLength;
    if (codePoint === VS16 && previousVisibleWidth === 1) {
      previousVisibleWidth = 2;
      promotedPaddingPending = true;
    } else if (width > 0) {
      previousVisibleWidth = width;
    }
  }

  return normalized;
}

/** Exact observed cell projection of a capture-pane -e -N row stream.
 * This decodes a snapshot, not a VT emulator. Unsupported escapes fail closed.
 * OSC8 and hidden parser state are deliberately not certified by this decoder. */
export interface TmuxObservedCell {
  grapheme: string;
  width: 0 | 1 | 2;
  continuation: boolean;
  fg: string;
  bg: string;
  style: number;
}
export const TMUX_OBSERVED_FIELDS = ['grapheme', 'width', 'continuation', 'fg', 'bg', 'style', 'cursor-position', 'cursor-visible'] as const;
export function decodeTmuxCaptureRows(raw: string, cols: number): TmuxObservedCell[][] {
  if (!Number.isSafeInteger(cols) || cols < 1) throw new Error('invalid capture width');
  let fg = 'default', bg = 'default', style = 0;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  // tmux can merge a spacing heart into the preceding skin-tone cell. Its
  // serialized text loses that cell boundary; do not certify a guessed width.
  if (/[\u{1f3fb}-\u{1f3ff}]\u2764/u.test(raw)) throw new Error('ambiguous tmux emoji cell boundary');
  const lines = normalizeTmuxCaptureCells(raw).split('\n');
  // capture-pane terminates its serialized last physical row with one LF.
  if (lines.at(-1) === '') lines.pop();
  const rows: TmuxObservedCell[][] = [];
  const applySgr = (body: string) => {
    // tmux uses colon subparameters for underline variants and overline.
    // These decorations are outside this projection; consume them without
    // mistaking their parameters for bold, blink, or foreground colours.
    body = body.replace(/(38|48|58):2::?(\d+):(\d+):(\d+)/g, '$1;2;$2;$3;$4')
      .replace(/(38|48|58):5:(\d+)/g, '$1;5;$2')
      .replace(/\b(4|5):[0-9]+/g, (_, kind) => kind === '4' ? '4' : '53');
    if (!/^[0-9;]*$/.test(body)) throw new Error('unsupported capture SGR');
    const codes = body === '' ? [0] : body.split(';').map(x => x === '' ? 0 : Number(x));
    for (let i = 0; i < codes.length; i++) {
      const n = codes[i]!;
      if (n === 0) { fg = bg = 'default'; style = 0; }
      else if (n >= 1 && n <= 9) style |= 1 << (n - 1);
      else if (n === 21) style = (style & ~8) | 512;
      else if (n === 22) style &= ~3;
      else if (n === 23) style &= ~4;
      else if (n === 24) style &= ~(8 | 512);
      else if (n === 25) style &= ~(16 | 32);
      else if (n === 27) style &= ~64;
      else if (n === 28) style &= ~128;
      else if (n === 29) style &= ~256;
      else if (n === 39) fg = 'default';
      else if (n === 49) bg = 'default';
      else if (n >= 30 && n <= 37) fg = `index:${n - 30}`;
      else if (n >= 40 && n <= 47) bg = `index:${n - 40}`;
      else if (n >= 90 && n <= 97) fg = `index:${n - 90 + 8}`;
      else if (n >= 100 && n <= 107) bg = `index:${n - 100 + 8}`;
      else if (n === 53 || n === 55 || n === 59) { /* unobserved decoration */ }
      else if (n === 38 || n === 48 || n === 58) {
        const mode = codes[++i];
        const count = mode === 5 ? 1 : mode === 2 ? 3 : 0;
        if (!count) throw new Error('unsupported capture color');
        const values = codes.slice(i + 1, i + count + 1);
        if (values.length !== count || values.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error('invalid capture color');
        i += count;
        const color = mode === 5 ? `index:${values[0]}` : `rgb:${values.join(',')}`;
        if (n === 38) fg = color; else if (n === 48) bg = color;
      } else throw new Error(`unobserved capture SGR ${n}`);
    }
  };
  for (const line of lines) {
    const cells: TmuxObservedCell[] = [];
    let at = 0;
    while (at < line.length) {
      if (line.charCodeAt(at) === ESC) {
        if (line.startsWith('\x1b]8;', at)) { at = escapeEnd(line, at); continue; }
        const match = /^\x1b\[([0-9;:]*)m/.exec(line.slice(at));
        if (!match) throw new Error('unsupported capture escape');
        applySgr(match[1]!); at += match[0].length; continue;
      }
      const next = line.indexOf('\x1b', at);
      const text = line.slice(at, next < 0 ? line.length : next);
      for (const { segment: cluster } of segmenter.segment(text)) {
        // tmux merges emoji ZWJ/flag/skin-tone clusters, but Thai spacing
        // vowels remain separate cells even inside a Unicode grapheme.
        const pieces = /[\u0e00-\u0e7f]/u.test(cluster)
          ? cluster.match(/[^\p{Mark}][\p{Mark}]*/gu) ?? [cluster] : [cluster];
        for (const segment of pieces) {
        if (/[\x00-\x1f\x7f]/.test(segment)) throw new Error('control byte in capture cells');
        let width: 0 | 1 | 2 = 0;
        width = segment.length === 1 && segment.charCodeAt(0) >= 0x20 && segment.charCodeAt(0) < 0x7f
          ? 1 : Math.min(2, stringCells(segment)) as 0 | 1 | 2;
        if (segment.includes('\ufe0f') && width === 1) width = 2;
        if (width === 0) {
          const previous = cells.findLast(c => !c.continuation);
          if (!previous) throw new Error('orphan combining capture cell');
          previous.grapheme += segment;
          continue;
        }
        cells.push({ grapheme: segment, width, continuation: false, fg, bg, style });
        if (width === 2) cells.push({ grapheme: '', width: 0, continuation: true, fg, bg, style });
      }
      }
      at += text.length;
    }
    if (cells.length > cols) throw new Error('capture row exceeds geometry');
    while (cells.length < cols) cells.push({ grapheme: ' ', width: 1, continuation: false, fg: 'default', bg: 'default', style: 0 });
    rows.push(cells);
  }
  return rows;
}
