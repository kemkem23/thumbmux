const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = DEFAULT_MAX_LINE_BYTES + 64 * 1024;

export type TmuxControlStreamOptions = {
  maxLineBytes?: number;
  maxBufferedBytes?: number;
};

function boundedOption(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 256 * 1024 * 1024) {
    throw new Error(`${label} must be a positive integer no greater than 268435456`);
  }
  return value;
}

/**
 * Byte-preserving line buffer for tmux control mode.
 *
 * tmux octal-escapes control bytes, but leaves printable UTF-8 output bytes
 * raw. Lines therefore stay Uint8Array until a notification parser has split
 * its ASCII header from its byte payload. If a consumer fails, all
 * not-yet-consumed bytes remain here while the caller pauses stdout.
 */
export class TmuxControlStreamBuffer {
  readonly maxLineBytes: number;
  readonly maxBufferedBytes: number;
  private buffer = Buffer.alloc(0);

  constructor(options: TmuxControlStreamOptions = {}) {
    this.maxLineBytes = boundedOption(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES, "maxLineBytes");
    this.maxBufferedBytes = boundedOption(
      options.maxBufferedBytes,
      DEFAULT_MAX_BUFFERED_BYTES,
      "maxBufferedBytes",
    );
    if (this.maxBufferedBytes < this.maxLineBytes) {
      throw new Error("maxBufferedBytes must be at least maxLineBytes");
    }
  }

  get bufferedBytes(): number {
    return this.buffer.byteLength;
  }

  append(chunk: Uint8Array): void {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("tmux control stdout must provide raw bytes");
    }
    // Retain the whole delivered chunk before reporting pressure. The caller
    // can pause the source without dropping bytes already removed from the OS.
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    if (this.buffer.byteLength > this.maxBufferedBytes) {
      throw new Error(`tmux control stream exceeds ${this.maxBufferedBytes} buffered bytes`);
    }
  }

  peekLine(): Uint8Array | null {
    const newline = this.buffer.indexOf(0x0a);
    if (newline < 0) {
      if (this.buffer.byteLength > this.maxLineBytes) {
        throw new Error(`tmux control line exceeds ${this.maxLineBytes} bytes`);
      }
      return null;
    }
    if (newline > this.maxLineBytes) {
      throw new Error(`tmux control line exceeds ${this.maxLineBytes} bytes`);
    }
    return this.buffer.subarray(0, newline);
  }

  consumeLine(): void {
    const newline = this.buffer.indexOf(0x0a);
    if (newline < 0) throw new Error("tmux control stream has no complete line to consume");
    this.buffer = this.buffer.subarray(newline + 1);
  }

  nextLine(): Uint8Array | null {
    const line = this.peekLine();
    if (line === null) return null;
    this.consumeLine();
    return line;
  }

  finish(): void {
    if (this.buffer.byteLength !== 0) {
      throw new Error("tmux control stream ended with a partial line");
    }
  }
}
