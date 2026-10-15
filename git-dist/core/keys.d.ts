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
    /**
     * DECCKM application-cursor mode. When true, unmodified ArrowUp/Down/Right/Left
     * and Home/End emit SS3 (`ESC O A`/`B`/`C`/`D`, `ESC O H`, `ESC O F`) instead of
     * CSI (`ESC [ …`). Modified forms still use CSI-with-modifier.
     */
    applicationCursorKeys?: boolean;
};
export type ReservedKeyAlternative = {
    id: string;
    label: string;
    sequence: string | null;
    fallback: 'soft-key' | 'native-client' | 'unsupported';
};
/**
 * Explicit alternatives for shortcuts a normal browser tab may consume before
 * JavaScript receives a KeyboardEvent.  This table powers a soft-key palette;
 * it is not evidence that the corresponding physical shortcut is capturable.
 * G7 must measure that with real browsers and hardware keyboards.
 */
export declare const reservedKeyAlternatives: readonly ReservedKeyAlternative[];
export declare function reservedKeyAlternative(id: string): ReservedKeyAlternative | null;
/**
 * Returns bytes to send to the pane, or null = let the browser handle it.
 *
 * `altIsMeta` defaults to true, preserving PC-style Alt behavior for printable
 * keys. Set it to false for macOS Option composition; printable Option output
 * is then sent verbatim while named keys still encode Alt as a modifier.
 */
export declare function keyboardEventToSequence(e: KeyLike, opts?: KeyboardSequenceOptions): string | null;
/**
 * Wrap text for bracketed paste; normalize \r\n and \n to \r, and strip ESC —
 * both like xterm.js.
 *
 * The ESC strip is the load-bearing half. Clipboard content is not trusted input:
 * a payload carrying its own ESC[201~ closes paste mode wherever the author of
 * that text chose, and every byte after it reaches the pty as live keys, carriage
 * returns included. Delimiting without sanitizing hands an attacker the ability
 * to end the quoting they are inside of, which is the same shape as any other
 * injection. xterm.js removes ESC for exactly this reason.
 */
export declare function bracketedPaste(text: string): string;
