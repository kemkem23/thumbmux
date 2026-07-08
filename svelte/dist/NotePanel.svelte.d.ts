type $$ComponentProps = {
    note?: string;
    placeholder?: string;
    editable?: boolean;
    saving?: boolean;
    onSave?: (text: string) => void;
    /** host actions rendered as buttons, e.g. { label: '✨ distill', onTap, busy } */
    actions?: {
        label: string;
        onTap: () => void;
        busy?: boolean;
    }[];
    labels?: {
        edit: string;
        save: string;
        cancel: string;
    };
};
declare const NotePanel: import("svelte").Component<$$ComponentProps, {}, "">;
type NotePanel = ReturnType<typeof NotePanel>;
export default NotePanel;
