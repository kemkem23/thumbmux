import { describe, expect, test } from 'bun:test';
import * as app from '../src';
import {
  DEFAULT_APP_LABELS,
  type AppAdapters,
  type AppLabels,
} from '../src/config';

const EXPECTED_LABEL_KEYS = [
  'actionCopy',
  'actionDpad',
  'actionFontDown',
  'actionFontUp',
  'actionShortcuts',
  'actionTheme',
  'actionType',
  'actionUpload',
  'actionUploading',
  'close',
  'composerCompose',
  'composerDirect',
  'composerDirectAria',
  'composerHintCompose',
  'composerHintDirect',
  'composerPlaceholder',
  'composerSend',
  'fabAria',
  'gridAll',
  'gridEmpty',
  'gridGroup',
  'gridLoading',
  'gridNew',
  'gridSearchLabel',
  'gridSearchPlaceholder',
  'gridUngrouped',
  'hubCount',
  'hubTitle',
  'hudBack',
  'hudChip',
  'hudConnected',
  'hudOffline',
  'launchAction',
  'launchBusy',
  'launchContext',
  'launchFailed',
  'launchHint',
  'launchModel',
  'launchPermission',
  'launchTitle',
  'noteCancel',
  'noteEdit',
  'noteEmpty',
  'noteSave',
  'promptsEmpty',
  'promptsLoading',
  'promptsTitle',
  'scrollBottom',
  'scrollNewContent',
  'shortcutAdd',
  'shortcutDelete',
  'shortcutDown',
  'shortcutLabel',
  'shortcutSend',
  'shortcutUp',
  'shortcutsTitle',
  'terminalAria',
  'themeBackground',
  'themeCustom',
  'themeDark',
  'themeDefault',
  'themeLight',
  'themeTitle',
  'uploadFailed',
] as const satisfies readonly (keyof AppLabels)[];

const plannedAdapters = {
  sendKeys: (_session: string, _keys: string) => {},
  submitAgent: () => 'generic',
  routes: { openSession: (_name: string) => {}, showHub: () => {} },
  spawn: {
    presets: [],
    contexts: async () => [],
    launch: async () => ({ name: 'generated-session' }),
  },
  sessionMeta: () => [],
  notes: { load: async () => '', save: async () => {} },
  prompts: async () => [],
  upload: { endpoint: () => '/upload', dir: 'uploads' },
  termProps: () => ({ claimGeometry: false }),
  theme: { defaultBg: '#101014' },
  labels: { hubTitle: 'Custom' },
  extraActions: () => [],
  extraDismissables: () => false,
} satisfies AppAdapters;

void plannedAdapters;

describe('app config contract', () => {
  test('barrel exports the default labels value', () => {
    expect(app.DEFAULT_APP_LABELS).toBe(DEFAULT_APP_LABELS);
  });

  test('ships the complete English default label set', () => {
    expect(Object.keys(DEFAULT_APP_LABELS).sort()).toEqual([...EXPECTED_LABEL_KEYS].sort());

    const strings = Object.values(DEFAULT_APP_LABELS)
      .filter((value): value is string => typeof value === 'string');
    expect(strings.every((value) => value.trim().length > 0)).toBe(true);
    expect(strings.join('\n')).not.toMatch(/[\u0e00-\u0e7f]/);
  });

  test('formats count, terminal, and error labels from runtime inputs', () => {
    expect(DEFAULT_APP_LABELS.hubCount(1)).toBe('1 session');
    expect(DEFAULT_APP_LABELS.hubCount(2)).toBe('2 sessions');
    expect(DEFAULT_APP_LABELS.terminalAria('build-pane')).toBe('Terminal build-pane');
    expect(DEFAULT_APP_LABELS.uploadFailed('network down')).toBe('Upload failed: network down');
  });
});
