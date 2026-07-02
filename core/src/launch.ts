/**
 * Launch presets — what "+ terminal" offers and the exact command each choice
 * injects. Pure data + a pure builder so hosts (and tests) can verify every
 * generated command without spawning anything.
 *
 * The default presets mirror the AI-agent CLIs this stack was built around:
 * each one injects its own permission-bypass flag by default (these UIs drive
 * long-running autonomous agents — prompting for permission on a phone
 * defeats the point), with a dropdown to pick a stricter mode, and a model
 * dropdown forwarded to the CLI. A blank preset opens a plain shell.
 */

export type LaunchOption = {
  value: string;
  label: string;
  /** CLI fragment injected when selected ('' = inject nothing). */
  flag: string;
};

export type LaunchPreset = {
  id: string;
  label: string;
  /** accent color for the launcher card */
  color: string;
  /** host hint: session-name prefix / agent kind ('' = blank shell) */
  agent: string;
  /** spawn into an isolated git worktree (host implements) */
  worktree?: boolean;
  /** base executable + always-on flags */
  baseCommand: string;
  permissionOptions: LaunchOption[];
  modelOptions: LaunchOption[];
};

export type LaunchSpec = {
  presetId: string;
  agent: string;
  worktree: boolean;
  permission: string;
  model: string;
  /** the full command line the host should run ('' for a blank shell) */
  command: string;
};

/** Compose the final command: base + permission flag + model flag. */
export function buildLaunchCommand(
  preset: LaunchPreset,
  permission?: string,
  model?: string,
): string {
  if (!preset.baseCommand) return '';
  const perm = preset.permissionOptions.find((o) => o.value === permission)
    ?? preset.permissionOptions[0];
  const mod = preset.modelOptions.find((o) => o.value === model)
    ?? preset.modelOptions[0];
  return [preset.baseCommand, perm?.flag, mod?.flag].filter(Boolean).join(' ');
}

export function buildLaunchSpec(
  preset: LaunchPreset,
  permission?: string,
  model?: string,
): LaunchSpec {
  const perm = (preset.permissionOptions.find((o) => o.value === permission)
    ?? preset.permissionOptions[0]);
  const mod = (preset.modelOptions.find((o) => o.value === model)
    ?? preset.modelOptions[0]);
  return {
    presetId: preset.id,
    agent: preset.agent,
    worktree: !!preset.worktree,
    permission: perm?.value ?? '',
    model: mod?.value ?? '',
    command: buildLaunchCommand(preset, permission, model),
  };
}

const CLAUDE_PERMISSIONS: LaunchOption[] = [
  { value: 'bypass', label: 'Bypass permissions', flag: '--dangerously-skip-permissions' },
  { value: 'accept-edits', label: 'Auto-accept edits', flag: '--permission-mode acceptEdits' },
  { value: 'plan', label: 'Plan mode', flag: '--permission-mode plan' },
  { value: 'ask', label: 'Ask every time', flag: '' },
];

const CLAUDE_MODELS: LaunchOption[] = [
  { value: 'default', label: 'Default model', flag: '' },
  { value: 'opus', label: 'Opus', flag: '--model opus' },
  { value: 'sonnet', label: 'Sonnet', flag: '--model sonnet' },
  { value: 'haiku', label: 'Haiku', flag: '--model haiku' },
];

const CODEX_PERMISSIONS: LaunchOption[] = [
  { value: 'bypass', label: 'Bypass approvals', flag: '--dangerously-bypass-approvals-and-sandbox' },
  { value: 'auto', label: 'Workspace sandbox', flag: '--full-auto' },
  { value: 'ask', label: 'Ask every time', flag: '' },
];

const CODEX_MODELS: LaunchOption[] = [
  { value: 'default', label: 'Default model', flag: '' },
  { value: 'gpt-5.5', label: 'GPT-5.5', flag: '-m gpt-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4', flag: '-m gpt-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini', flag: '-m gpt-5.4-mini' },
];

const GROK_PERMISSIONS: LaunchOption[] = [
  { value: 'bypass', label: 'Bypass permissions', flag: '--permission-mode bypassPermissions' },
  { value: 'ask', label: 'Ask every time', flag: '' },
];

const GROK_MODELS: LaunchOption[] = [
  { value: 'default', label: 'Default model', flag: '' },
  { value: 'grok-build', label: 'Grok Build', flag: '--model grok-build' },
  { value: 'grok-composer-2.5-fast', label: 'Composer 2.5 fast', flag: '--model grok-composer-2.5-fast' },
];

/** The stock seven: three agents × plain/worktree, plus a blank shell. */
export const DEFAULT_LAUNCH_PRESETS: LaunchPreset[] = [
  {
    id: 'claude', label: 'Claude Code', color: '#B05606', agent: 'cc',
    baseCommand: 'claude',
    permissionOptions: CLAUDE_PERMISSIONS, modelOptions: CLAUDE_MODELS,
  },
  {
    id: 'claude-worktree', label: 'Claude Code · worktree', color: '#B05606', agent: 'cc', worktree: true,
    baseCommand: 'claude',
    permissionOptions: CLAUDE_PERMISSIONS, modelOptions: CLAUDE_MODELS,
  },
  {
    id: 'codex', label: 'Codex', color: '#0709BD', agent: 'codex',
    baseCommand: 'codex',
    permissionOptions: CODEX_PERMISSIONS, modelOptions: CODEX_MODELS,
  },
  {
    id: 'codex-worktree', label: 'Codex · worktree', color: '#0709BD', agent: 'codex', worktree: true,
    baseCommand: 'codex',
    permissionOptions: CODEX_PERMISSIONS, modelOptions: CODEX_MODELS,
  },
  {
    id: 'grok', label: 'Grok', color: '#1A1A1A', agent: 'grok',
    baseCommand: 'grok',
    permissionOptions: GROK_PERMISSIONS, modelOptions: GROK_MODELS,
  },
  {
    id: 'grok-worktree', label: 'Grok · worktree', color: '#1A1A1A', agent: 'grok', worktree: true,
    baseCommand: 'grok',
    permissionOptions: GROK_PERMISSIONS, modelOptions: GROK_MODELS,
  },
  {
    id: 'blank', label: 'Blank terminal', color: '#6A645C', agent: '',
    baseCommand: '',
    permissionOptions: [{ value: 'none', label: '—', flag: '' }],
    modelOptions: [{ value: 'none', label: '—', flag: '' }],
  },
];
