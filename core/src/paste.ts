export type PasteInfo = {
  text: string;
  lineCount: number;
  byteLength: number;
  reason: 'multiline' | 'large' | 'multiline-large';
};

export type PasteInfoOptions = {
  warnLines?: number;
  warnBytes?: number;
};

const DEFAULT_WARN_LINES = 6;
const DEFAULT_WARN_BYTES = 4096;

export function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x7f) bytes += 1;
    else if (cp <= 0x7ff) bytes += 2;
    else if (cp <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

export function pasteInfo(text: string, opts: PasteInfoOptions = {}): PasteInfo | null {
  const warnLines = opts.warnLines ?? DEFAULT_WARN_LINES;
  const warnBytes = opts.warnBytes ?? DEFAULT_WARN_BYTES;
  const lineCount = text.split(/\r\n|\r|\n/).length;
  const byteLength = utf8ByteLength(text);
  const multiline = warnLines > 0 && lineCount >= warnLines;
  const large = warnBytes > 0 && byteLength >= warnBytes;
  if (!multiline && !large) return null;
  return {
    text,
    lineCount,
    byteLength,
    reason: multiline && large ? 'multiline-large' : multiline ? 'multiline' : 'large',
  };
}
