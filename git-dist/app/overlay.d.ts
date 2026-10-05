export type OverlayState = {
    composerOpen: boolean;
    themeOpen: boolean;
    fabOpen: boolean;
};
export type OverlayAction = 'close-composer' | 'close-theme' | 'dismiss-host' | 'close-fab' | 'open-composer';
export type OverlayTransition = {
    action: OverlayAction;
    state: OverlayState;
};
/** Pure terminal-stage transition: dismiss one layer, or open the composer. */
export declare function nextStageOverlay(current: Readonly<OverlayState>, hostDismissable?: boolean): OverlayTransition;
export type ComposerPrefillTarget = {
    text: string;
    mode: 'compose' | 'direct';
    openCompose(): void;
};
/** Restore an optimistic draft in the visible composer after a failed action. */
export declare function prefillOnError(composer: ComposerPrefillTarget, draft: string): void;
