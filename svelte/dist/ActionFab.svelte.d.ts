export type FabActionChoice = {
    id: string;
    label: string;
    testid?: string;
    /** Marks the currently active member of this mutually-exclusive group. */
    selected?: boolean;
    /** Longer accessible name when the visible label is intentionally terse. */
    ariaLabel?: string;
    onTap: () => void;
};
export type FabAction = {
    id: string;
    label: string;
    /** accent-bordered (e.g. preset send actions) */
    primary?: boolean;
    testid?: string;
    /** small trailing tag, e.g. "SEND" */
    tag?: string;
    onTap: () => void;
};
/** Optional one-level flyout kept separate from `FabAction` so adding this
 * presentation does not widen the frozen action type used by app adapters. */
export type FabActionFlyout = {
    actionId: string;
    choices: readonly FabActionChoice[];
    ariaLabel?: string;
};
type $$ComponentProps = {
    open?: boolean;
    /** rotate the FAB into ✕ posture (any sheet open) */
    active?: boolean;
    actions: FabAction[];
    flyouts?: readonly FabActionFlyout[];
    onFab: (e: MouseEvent) => void;
    fabAria?: string;
};
declare const ActionFab: import("svelte").Component<$$ComponentProps, {}, "open">;
type ActionFab = ReturnType<typeof ActionFab>;
export default ActionFab;
