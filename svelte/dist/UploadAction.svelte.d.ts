/** UploadAction — the turnkey attach-files piece. Renders only a hidden
   * file input; call open() from any button (ActionFab slot, toolbar…), and
   * it uploads the picked files to `endpoint`, then hands you the stored
   * paths — ready for formatUploadMessage → composer prefill. */
import { type UploadedFile } from '@thumbmux/core';
type $$ComponentProps = {
    endpoint?: string;
    /** fallback prefix for prefill paths when the upload response omits `dir` */
    dir?: string;
    accept?: string;
    busy?: boolean;
    /** Host-owned multipart fields plus an opaque per-request settlement context. */
    prepareForm?: (files: readonly File[], form: FormData) => unknown | Promise<unknown>;
    /** Observe parsed HTTP state with the exact context returned for this request. */
    onResponse?: (files: readonly File[], response: Response, data: unknown, context: unknown) => void | Promise<void>;
    /** message uses the response `dir`, falling back to the `dir` prop */
    onUploaded: (message: string, files: UploadedFile[]) => void;
    onError: (message: string) => void;
};
declare const UploadAction: import("svelte").Component<$$ComponentProps, {
    open: () => void;
    uploadFiles: (files: File[] | FileList) => Promise<void>;
}, "busy">;
type UploadAction = ReturnType<typeof UploadAction>;
export default UploadAction;
