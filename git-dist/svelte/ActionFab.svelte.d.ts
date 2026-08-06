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
type $$ComponentProps = {
    open?: boolean;
    /** rotate the FAB into ✕ posture (any sheet open) */
    active?: boolean;
    actions: FabAction[];
    onFab: (e: MouseEvent) => void;
    fabAria?: string;
};
declare const ActionFab: import("svelte").Component<$$ComponentProps, {}, "open">;
type ActionFab = ReturnType<typeof ActionFab>;
export default ActionFab;
