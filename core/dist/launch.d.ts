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
export declare function buildLaunchCommand(preset: LaunchPreset, permission?: string, model?: string): string;
export declare function buildLaunchSpec(preset: LaunchPreset, permission?: string, model?: string): LaunchSpec;
/** The stock seven: three agents × plain/worktree, plus a blank shell. */
export declare const DEFAULT_LAUNCH_PRESETS: LaunchPreset[];
