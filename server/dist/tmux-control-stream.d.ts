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
export type TmuxControlEvent = TmuxControlOutputEvent | TmuxControlLayoutEvent | TmuxControlPauseEvent | TmuxControlExitEvent;
export type TmuxControlStreamParserOptions = Readonly<{
    /** Only output and layout events for this exact tmux pane are emitted. */
    paneId: string;
    /** Optional exact window filter for layout notifications. */
    windowId?: string;
    /** Bound memory if a corrupt source never terminates a control-mode line. */
    maxBufferedLineBytes?: number;
}>;
/** Decode tmux control-mode value escaping without a UTF-8 round trip. */
export declare function decodeTmuxControlValue(value: Uint8Array): Uint8Array;
/** Locate a pane leaf in tmux's canonical layout string. */
export declare function paneGeometryFromTmuxLayout(layout: string, paneId: string): {
    cols: number;
    rows: number;
} | null;
export declare class TmuxControlStreamParser {
    private pending;
    private commandBlock;
    private readonly paneId;
    private readonly windowId;
    private readonly maxBufferedLineBytes;
    constructor(options: TmuxControlStreamParserOptions);
    push(chunk: Uint8Array): TmuxControlEvent[];
    finish(): void;
    private parseLine;
}
