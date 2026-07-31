export type OverlayState = {
  composerOpen: boolean;
  themeOpen: boolean;
  fabOpen: boolean;
};

export type OverlayAction =
  | 'close-composer'
  | 'close-theme'
  | 'dismiss-host'
  | 'close-fab'
  | 'open-composer';

export type OverlayTransition = {
  action: OverlayAction;
  state: OverlayState;
};

/** Pure terminal-stage transition: dismiss one layer, or open the composer. */
export function nextStageOverlay(
  current: Readonly<OverlayState>,
  hostDismissable = false,
): OverlayTransition {
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

export type ComposerPrefillTarget = {
  text: string;
  mode: 'compose' | 'direct';
  openCompose(): void;
};

/** Restore an optimistic draft in the visible composer after a failed action. */
export function prefillOnError(
  composer: ComposerPrefillTarget,
  draft: string,
): void {
  composer.text = draft;
  composer.mode = 'compose';
  composer.openCompose();
}
