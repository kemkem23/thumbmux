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
export declare function normalizeTmuxCaptureCells(text: string): string;
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
export declare const TMUX_OBSERVED_FIELDS: readonly ["grapheme", "width", "continuation", "fg", "bg", "style", "cursor-position", "cursor-visible"];
/** `TmuxObservedCell.style` bits: SGR n (1..9) sets bit n-1, SGR 21 sets
 * DOUBLE_UNDERLINE. The decoder keeps every bit it reads (dim, rapid blink,
 * hidden included); a consumer that compares against a parser limited to a
 * subset must mask its comparison, never these cells. */
export declare const TMUX_STYLE_BITS: {
    readonly BOLD: 1;
    readonly DIM: 2;
    readonly ITALIC: 4;
    readonly UNDERLINE: 8;
    readonly BLINK: 16;
    readonly RAPID_BLINK: 32;
    readonly REVERSE: 64;
    readonly HIDDEN: 128;
    readonly STRIKE: 256;
    readonly DOUBLE_UNDERLINE: 512;
};
/** Screen decode with row isolation (FIX1-PLAN §7.4 / A-M3): an emoji whose
 * tmux cell boundary cannot be recovered makes only its own row uncertain.
 * The row is still drawn with Unicode widths; `uncertainRows` tells the
 * calibrator never to certify it. Any other decode fault still throws. */
export declare function decodeTmuxCaptureScreen(raw: string, cols: number): {
    rows: TmuxObservedCell[][];
    uncertainRows: number[];
};
/** Strict decode: throws on any ambiguous emoji boundary. Oracle use only;
 * the capture path uses decodeTmuxCaptureScreen / TmuxCaptureDecoder. */
export declare function decodeTmuxCaptureRows(raw: string, cols: number): TmuxObservedCell[][];
/** Exact per-line memo for one pane's repeated overlap. The key is the raw
 * physical row plus the SGR state carried into it, so a hit returns exactly
 * what decodeTmuxCaptureRows would. Returned rows are shared between calls and
 * typed read-only; freezing them doubled cold decode time, so callers must not
 * mutate them (the matcher clones what it keeps). Their cells are interned and
 * frozen, so one cell object can appear in many rows. */
export declare class TmuxCaptureDecoder {
    readonly cols: number;
    private readonly maxEntries;
    private readonly minEntries;
    private cache;
    private generation;
    hits: number;
    misses: number;
    /** Row indexes of the last decode() that are isolated as uncertain. */
    uncertainRows: number[];
    /** Retention follows the captures in use (I4-FIX1 F11, CANARY-FIX M): after
     * each decode the memo keeps the rows the last two decodes returned, so a
     * steady tail keeps the overlap it hits and a run of full 4500-row captures
     * stays warm. A row older than both is dropped: tmux returns it again only
     * in a later full capture, which re-decodes it once. `minEntries` is the
     * floor of rows kept regardless (oldest dropped first), `maxEntries` the
     * cap. The old floor of 1024 kept rows no capture returned any more; each
     * pinned its cells plus the runtime's canonical and frame side tables
     * (~4 KB/row): 30 MiB at 12 min of the 21-pane soak, growing all 30 min. */
    constructor(cols: number, maxEntries?: number, minEntries?: number);
    get size(): number;
    private trim;
    decode(raw: string): (readonly Readonly<TmuxObservedCell>[])[];
    private decodeLines;
}
export interface TmuxCaptureRowEvidence {
    cells: readonly TmuxObservedCell[] | null;
    /** True only for rows decoded exactly as tmux serialized them. */
    certain: boolean;
    reason: 'observed' | 'ambiguous-cell-boundary' | 'unsupported-row' | 'unknown-style-state';
}
/** Diagnostic projection. Unknown cells are never padded into invented blanks.
 * An ambiguous emoji row keeps best-effort Unicode-width cells with
 * certain=false (row isolation): the screen stays drawable and `complete`,
 * only that row is uncertain. Fail closed after an unparsed escape until an
 * explicit reset establishes the next row's style state again. */
export declare function decodeTmuxCaptureEvidence(raw: string, cols: number): {
    rows: TmuxCaptureRowEvidence[];
    complete: boolean;
    uncertainRows: number[];
};
