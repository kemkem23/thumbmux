/** Copy plain text without assuming a secure browser origin.
 *
 * `navigator.clipboard` is unavailable on the plain-HTTP LAN deployments that
 * thumbmux supports, so interactive chrome needs the same small legacy escape
 * hatch as TermView's buffer-copy path. The temporary textarea is always
 * removed and focus is restored to the button that initiated the copy. */
export async function copyPlainText(text) {
    if (!text)
        return false;
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    }
    catch { /* fall through to the legacy path */ }
    if (typeof document === 'undefined')
        return false;
    const previousFocus = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    let textarea = null;
    try {
        textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.readOnly = true;
        textarea.setAttribute('aria-hidden', 'true');
        textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(textarea);
        textarea.select();
        return document.execCommand('copy');
    }
    catch {
        return false;
    }
    finally {
        textarea?.remove();
        previousFocus?.focus();
    }
}
