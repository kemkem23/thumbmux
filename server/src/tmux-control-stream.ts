/**
 * Incremental parser for the small, ordered subset of tmux control mode used by
 * the durable terminal recorder. Control-mode notifications put pane output and
 * layout changes on the same byte stream, which gives replay an authoritative
 * resize/output order that two independent polling channels cannot provide.
 */

export type TmuxControlOutputEvent = Readonly<{
  type: "output";
  paneId: string;
  bytes: Uint8Array;
  /** Milliseconds tmux buffered the output. Present for %extended-output. */
  ageMs: number | null;
}>;

export type TmuxControlLayoutEvent = Readonly<{
  type: "layout";
  windowId: string;
  paneId: string;
  cols: number;
  rows: number;
}>;

export type TmuxControlPauseEvent = Readonly<{
  type: "pause" | "continue";
  paneId: string;
}>;

export type TmuxControlExitEvent = Readonly<{
  type: "exit";
  reason: string;
}>;

export type TmuxControlEvent =
  | TmuxControlOutputEvent
  | TmuxControlLayoutEvent
  | TmuxControlPauseEvent
  | TmuxControlExitEvent;

export type TmuxControlStreamParserOptions = Readonly<{
  /** Only output and layout events for this exact tmux pane are emitted. */
  paneId: string;
  /** Optional exact window filter for layout notifications. */
  windowId?: string;
  /** Bound memory if a corrupt source never terminates a control-mode line. */
  maxBufferedLineBytes?: number;
}>;

const DEFAULT_MAX_BUFFERED_LINE_BYTES = 32 * 1024 * 1024;

function isOctal(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x37;
}

/** Decode tmux control-mode value escaping without a UTF-8 round trip. */
export function decodeTmuxControlValue(value: Uint8Array): Uint8Array {
  const output = Buffer.allocUnsafe(value.byteLength);
  let read = 0;
  let written = 0;
  while (read < value.byteLength) {
    const byte = value[read]!;
    if (byte !== 0x5c) {
      output[written++] = byte;
      read += 1;
      continue;
    }
    if (
      read + 3 >= value.byteLength
      || !isOctal(value[read + 1]!)
      || !isOctal(value[read + 2]!)
      || !isOctal(value[read + 3]!)
    ) {
      throw new Error(`invalid tmux control-mode escape at value byte ${read}`);
    }
    output[written++] = ((value[read + 1]! - 0x30) << 6)
      | ((value[read + 2]! - 0x30) << 3)
      | (value[read + 3]! - 0x30);
    read += 4;
  }
  return output.subarray(0, written);
}

function positiveInteger(text: string, label: string): number {
  if (!/^\d+$/.test(text)) throw new Error(`invalid tmux control-mode ${label}: ${text}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid tmux control-mode ${label}: ${text}`);
  }
  return value;
}

/** Locate a pane leaf in tmux's canonical layout string. */
export function paneGeometryFromTmuxLayout(
  layout: string,
  paneId: string,
): { cols: number; rows: number } | null {
  if (!/^%\d+$/.test(paneId)) throw new Error(`invalid tmux pane id: ${paneId}`);
  const numericPaneId = paneId.slice(1);
  const leaf = /(?:^|[,{\[])\s*(\d+)x(\d+),\d+,\d+,(\d+)(?=\s*(?:[,}\]]|$))/g;
  let found: { cols: number; rows: number } | null = null;
  for (const match of layout.matchAll(leaf)) {
    if (match[3] !== numericPaneId) continue;
    if (found) throw new Error(`tmux layout contains pane ${paneId} more than once`);
    found = {
      cols: positiveInteger(match[1]!, "pane width"),
      rows: positiveInteger(match[2]!, "pane height"),
    };
  }
  return found;
}

function ascii(buffer: Uint8Array): string {
  return Buffer.from(buffer).toString("ascii");
}

function startsWithAscii(buffer: Uint8Array, prefix: string): boolean {
  if (buffer.byteLength < prefix.length) return false;
  for (let index = 0; index < prefix.length; index++) {
    if (buffer[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}

export class TmuxControlStreamParser {
  private pending = Buffer.alloc(0);
  private commandBlock = false;
  private readonly paneId: string;
  private readonly windowId: string | null;
  private readonly maxBufferedLineBytes: number;

  constructor(options: TmuxControlStreamParserOptions) {
    if (!/^%\d+$/.test(options.paneId)) throw new Error(`invalid tmux pane id: ${options.paneId}`);
    if (options.windowId !== undefined && !/^@\d+$/.test(options.windowId)) {
      throw new Error(`invalid tmux window id: ${options.windowId}`);
    }
    const maximum = options.maxBufferedLineBytes ?? DEFAULT_MAX_BUFFERED_LINE_BYTES;
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new Error("tmux control-mode maxBufferedLineBytes must be a positive safe integer");
    }
    this.paneId = options.paneId;
    this.windowId = options.windowId ?? null;
    this.maxBufferedLineBytes = maximum;
  }

  push(chunk: Uint8Array): TmuxControlEvent[] {
    if (chunk.byteLength > 0) {
      this.pending = this.pending.byteLength === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.pending, Buffer.from(chunk)]);
    }
    const events: TmuxControlEvent[] = [];
    let consumed = 0;
    while (consumed < this.pending.byteLength) {
      const newline = this.pending.indexOf(0x0a, consumed);
      if (newline === -1) break;
      let line = this.pending.subarray(consumed, newline);
      if (line.byteLength > 0 && line[line.byteLength - 1] === 0x0d) {
        line = line.subarray(0, line.byteLength - 1);
      }
      consumed = newline + 1;
      const event = this.parseLine(line);
      if (event) events.push(event);
    }
    if (consumed > 0) this.pending = this.pending.subarray(consumed);
    if (this.pending.byteLength > this.maxBufferedLineBytes) {
      throw new Error(`tmux control-mode line exceeds ${this.maxBufferedLineBytes} buffered bytes`);
    }
    return events;
  }

  finish(): void {
    if (this.pending.byteLength !== 0) {
      throw new Error(`torn tmux control-mode line (${this.pending.byteLength} bytes)`);
    }
    if (this.commandBlock) throw new Error("torn tmux control-mode command block");
  }

  private parseLine(line: Uint8Array): TmuxControlEvent | null {
    if (startsWithAscii(line, "%begin ")) {
      if (this.commandBlock) throw new Error("nested tmux control-mode command block");
      this.commandBlock = true;
      return null;
    }
    if (startsWithAscii(line, "%end ") || startsWithAscii(line, "%error ")) {
      if (!this.commandBlock) throw new Error("tmux control-mode block ended without %begin");
      this.commandBlock = false;
      return null;
    }
    if (this.commandBlock) return null;

    if (startsWithAscii(line, "%output ")) {
      const firstSpace = line.indexOf(0x20, 8);
      if (firstSpace === -1) throw new Error("malformed tmux %output notification");
      const paneId = ascii(line.subarray(8, firstSpace));
      if (!/^%\d+$/.test(paneId)) throw new Error("malformed tmux %output pane id");
      if (paneId !== this.paneId) return null;
      return {
        type: "output",
        paneId,
        bytes: decodeTmuxControlValue(line.subarray(firstSpace + 1)),
        ageMs: null,
      };
    }

    if (startsWithAscii(line, "%extended-output ")) {
      const separator = Buffer.from(line).indexOf(Buffer.from(" : "));
      if (separator === -1) throw new Error("malformed tmux %extended-output notification");
      const head = ascii(line.subarray("%extended-output ".length, separator)).trim().split(/\s+/);
      if (head.length < 2 || !/^%\d+$/.test(head[0]!)) {
        throw new Error("malformed tmux %extended-output header");
      }
      const ageMs = Number(head[1]);
      if (!Number.isSafeInteger(ageMs) || ageMs < 0) {
        throw new Error("malformed tmux %extended-output age");
      }
      if (head[0] !== this.paneId) return null;
      return {
        type: "output",
        paneId: head[0]!,
        bytes: decodeTmuxControlValue(line.subarray(separator + 3)),
        ageMs,
      };
    }

    if (startsWithAscii(line, "%layout-change ")) {
      const fields = ascii(line).split(" ");
      if (fields.length < 4 || !/^@\d+$/.test(fields[1]!)) {
        throw new Error("malformed tmux %layout-change notification");
      }
      const windowId = fields[1]!;
      if (this.windowId && windowId !== this.windowId) return null;
      const geometry = paneGeometryFromTmuxLayout(fields[3]!, this.paneId)
        ?? paneGeometryFromTmuxLayout(fields[2]!, this.paneId);
      return geometry ? { type: "layout", windowId, paneId: this.paneId, ...geometry } : null;
    }

    if (startsWithAscii(line, "%pause ") || startsWithAscii(line, "%continue ")) {
      const type = startsWithAscii(line, "%pause ") ? "pause" : "continue";
      const paneId = ascii(line.subarray(type === "pause" ? 7 : 10)).trim();
      if (!/^%\d+$/.test(paneId)) throw new Error(`malformed tmux %${type} notification`);
      return paneId === this.paneId ? { type, paneId } : null;
    }

    if (Buffer.from(line).equals(Buffer.from("%exit")) || startsWithAscii(line, "%exit ")) {
      const reason = line.byteLength === 5 ? "" : Buffer.from(line.subarray(6)).toString("utf8");
      return { type: "exit", reason };
    }

    return null;
  }
}
