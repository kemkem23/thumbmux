import { describe, expect, test } from 'bun:test';
import {
  nextStageOverlay,
  prefillOnError,
  type OverlayState,
} from '../src/overlay';

const state = (
  composerOpen: boolean,
  themeOpen: boolean,
  fabOpen: boolean,
): OverlayState => ({ composerOpen, themeOpen, fabOpen });

describe('session overlay precedence', () => {
  test.each([
    {
      name: 'composer closes before every lower-priority overlay',
      current: state(true, true, true),
      hostDismissable: true,
      action: 'close-composer',
      next: state(false, true, true),
    },
    {
      name: 'theme closes after composer and before the host',
      current: state(false, true, true),
      hostDismissable: true,
      action: 'close-theme',
      next: state(false, false, true),
    },
    {
      name: 'host dismissable wins over the FAB slots',
      current: state(false, false, true),
      hostDismissable: true,
      action: 'dismiss-host',
      next: state(false, false, true),
    },
    {
      name: 'FAB slots close before opening the composer',
      current: state(false, false, true),
      hostDismissable: false,
      action: 'close-fab',
      next: state(false, false, false),
    },
    {
      name: 'an empty stage opens the composer',
      current: state(false, false, false),
      hostDismissable: false,
      action: 'open-composer',
      next: state(true, false, false),
    },
  ])('$name', ({ current, hostDismissable, action, next }) => {
    const inputBefore = { ...current };
    const transition = nextStageOverlay(current, hostDismissable);

    expect(transition.action).toBe(action);
    expect(transition.state).toEqual(next);
    expect(current).not.toBe(transition.state);
    expect(current).toEqual(inputBefore);
  });

  test('prefillOnError restores compose mode and opens exactly once', () => {
    let opens = 0;
    const composer = {
      text: '',
      mode: 'direct' as 'compose' | 'direct',
      openCompose: () => { opens += 1; },
    };

    prefillOnError(composer, 'draft that must survive');

    expect(composer.text).toBe('draft that must survive');
    expect(composer.mode).toBe('compose');
    expect(opens).toBe(1);
  });
});
