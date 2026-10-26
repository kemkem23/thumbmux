export type SpawnAgent = {
    id: string;
    label: string;
    color: string;
};
type $$ComponentProps = {
    open?: boolean;
    dark?: boolean;
    title: string;
    hint: string;
    agents: SpawnAgent[];
    busy?: boolean;
    busyLabel?: string;
    error?: string | null;
    onPick: (agentId: string) => void;
    onClose: () => void;
    closeAria?: string;
};
declare const NewTerminalSheet: import("svelte").Component<$$ComponentProps, {}, "">;
type NewTerminalSheet = ReturnType<typeof NewTerminalSheet>;
export default NewTerminalSheet;
