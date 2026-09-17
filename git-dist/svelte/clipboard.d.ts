/** Copy plain text without assuming a secure browser origin.
 *
 * `navigator.clipboard` is unavailable on the plain-HTTP LAN deployments that
 * thumbmux supports, so interactive chrome needs the same small legacy escape
 * hatch as TermView's buffer-copy path. The temporary textarea is always
 * removed and focus is restored to the button that initiated the copy. */
export declare function copyPlainText(text: string): Promise<boolean>;
