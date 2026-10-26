type $$ComponentProps = {
    /** Files the draft starts with; pass a new array to re-seed (e.g. `[]` after send). */
    files?: File[];
    accept?: string;
    multiple?: boolean;
    disabled?: boolean;
    /** Every draft change, as plain `File[]` — no ids, URLs or host metadata. */
    onChange: (files: File[]) => void;
};
declare const AttachmentDraftPicker: import("svelte").Component<$$ComponentProps, {
    open: () => void;
    addFiles: (incoming: File[] | FileList) => void;
    acceptPaste: (event: ClipboardEvent) => boolean;
    clear: () => void;
    currentFiles: () => File[];
}, "">;
type AttachmentDraftPicker = ReturnType<typeof AttachmentDraftPicker>;
export default AttachmentDraftPicker;
