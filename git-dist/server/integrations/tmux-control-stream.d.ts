export type TmuxControlStreamOptions = {
    maxLineBytes?: number;
    maxBufferedBytes?: number;
};
/**
 * Byte-preserving line buffer for tmux control mode.
 *
 * tmux octal-escapes control bytes, but leaves printable UTF-8 output bytes
 * raw. Lines therefore stay Uint8Array until a notification parser has split
 * its ASCII header from its byte payload. If a consumer fails, all
 * not-yet-consumed bytes remain here while the caller pauses stdout.
 */
export declare class TmuxControlStreamBuffer {
    readonly maxLineBytes: number;
    readonly maxBufferedBytes: number;
    private buffer;
    constructor(options?: TmuxControlStreamOptions);
    get bufferedBytes(): number;
    append(chunk: Uint8Array): void;
    peekLine(): Uint8Array | null;
    consumeLine(): void;
    nextLine(): Uint8Array | null;
    finish(): void;
}
