export type KeyLike = {
    key: string;
    code?: string;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    isComposing?: boolean;
};
export type KeyboardSequenceOptions = {
    /**
     * Treat Alt/Option as Meta for printable characters. Set false when the
     * caller wants Option-composed printable characters sent verbatim; named keys
     * still use Alt in their terminal modifier encoding. Ctrl+Alt printable
     * AltGr input is always sent verbatim.
     */
    altIsMeta?: boolean;
};
/**
 * Returns bytes to send to the pane, or null = let the browser handle it.
 *
 * `altIsMeta` defaults to true, preserving PC-style Alt behavior for printable
 * keys. Set it to false for macOS Option composition; printable Option output
 * is then sent verbatim while named keys still encode Alt as a modifier.
 */
export declare function keyboardEventToSequence(e: KeyLike, opts?: KeyboardSequenceOptions): string | null;
/** Wrap text for bracketed paste; normalize \r\n and \n to \r (like xterm.js). */
export declare function bracketedPaste(text: string): string;
