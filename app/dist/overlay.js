/** Pure terminal-stage transition: dismiss one layer, or open the composer. */
export function nextStageOverlay(current, hostDismissable = false) {
    if (current.composerOpen) {
        return {
            action: 'close-composer',
            state: { ...current, composerOpen: false },
        };
    }
    if (current.themeOpen) {
        return {
            action: 'close-theme',
            state: { ...current, themeOpen: false },
        };
    }
    if (hostDismissable) {
        return {
            action: 'dismiss-host',
            state: { ...current },
        };
    }
    if (current.fabOpen) {
        return {
            action: 'close-fab',
            state: { ...current, fabOpen: false },
        };
    }
    return {
        action: 'open-composer',
        state: { ...current, composerOpen: true },
    };
}
/** Restore an optimistic draft in the visible composer after a failed action. */
export function prefillOnError(composer, draft) {
    composer.text = draft;
    composer.mode = 'compose';
    composer.openCompose();
}
