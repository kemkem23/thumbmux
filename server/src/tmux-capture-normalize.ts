import { charCellWidth } from '@thumbmux/core';

const ESC = 0x1b;
const BEL = 0x07;
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

    const width = charCellWidth(codePoint);
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
