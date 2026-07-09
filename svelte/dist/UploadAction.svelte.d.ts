/** UploadAction — the turnkey attach-files piece. Renders only a hidden
   * file input; call open() from any button (ActionFab slot, toolbar…), and
   * it uploads the picked files to `endpoint`, then hands you the stored
   * paths — ready for formatUploadMessage → composer prefill. */
import { type UploadedFile } from '@thumbmux/core';
type $$ComponentProps = {
    endpoint?: string;
    /** display prefix used in the prefill message */
    dir?: string;
    accept?: string;
    busy?: boolean;
    /** message = formatUploadMessage(files, dir) — prefill your composer */
    onUploaded: (message: string, files: UploadedFile[]) => void;
    onError: (message: string) => void;
};
declare const UploadAction: import("svelte").Component<$$ComponentProps, {
    open: () => void;
    uploadFiles: (files: File[] | FileList) => Promise<void>;
}, "busy">;
type UploadAction = ReturnType<typeof UploadAction>;
export default UploadAction;
