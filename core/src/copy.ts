/**
 * Copy helpers — turn captured pane lines into clipboard-worthy plain text:
 * ANSI stripped, per-line trailing whitespace trimmed, trailing blank lines
 * dropped. The visual terminal is padded to the pane grid; nobody wants
 * that padding in a paste.
 */
import { stripAnsi } from './prompt-scan';

export function paneTextForCopy(lines: string[]): string {
  const out = lines.map((l) => stripAnsi(l ?? '').replace(/\s+$/, ''));
  let end = out.length;
  while (end > 0 && out[end - 1] === '') end--;
  return out.slice(0, end).join('\n');
}
