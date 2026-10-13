export type LaunchContext = {
    id: string;
    label: string;
};
/** LaunchSheet — the "+ terminal" picker. Preset rows (agents ± worktree +
   * a blank shell), each expanding into permission/model dropdowns and an
   * optional live command preview showing exactly what will be injected.
   * The host runs the command (or maps the spec onto its own spawn API). */
import { type LaunchPreset, type LaunchSpec } from '@thumbmux/core';
type $$ComponentProps = {
    open?: boolean;
    dark?: boolean;
    presets?: LaunchPreset[];
    /** optional workspace/topic picker (host-defined) */
    contexts?: LaunchContext[];
    /** show the injected command preview (hosts that build commands
     * server-side can hide it) */
    showCommand?: boolean;
    busy?: boolean;
    error?: string | null;
    onLaunch: (spec: LaunchSpec, contextId: string | null) => void;
    onClose: () => void;
    title?: string;
    hint?: string;
    contextLabel?: string;
    permissionLabel?: string;
    modelLabel?: string;
    launchLabel?: string;
    busyLabel?: string;
    closeAria?: string;
};
declare const LaunchSheet: import("svelte").Component<$$ComponentProps, {}, "">;
type LaunchSheet = ReturnType<typeof LaunchSheet>;
export default LaunchSheet;
