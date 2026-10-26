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
export declare function utf8ByteLength(text: string): number;
export declare function pasteInfo(text: string, opts?: PasteInfoOptions): PasteInfo | null;
