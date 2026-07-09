/**
 * Upload plumbing shared by client and server: safe stored names and the
 * composer prefill message. Pure — the actual I/O lives in
 * @thumbmux/server (createUploadHandler) and @thumbmux/svelte (UploadAction).
 */
export type UploadedFile = {
    original: string;
    stored: string;
};
/** Filesystem-safe stored name: path bits stripped, hostile chars collapsed,
 * length-capped, prefixed with a timestamp + entropy so names never collide. */
export declare function makeStoredName(original: string, now: number, entropy: string): string;
/** The message prefilled into the composer after an upload — one line per
 * file so a single SEND hands every path to the agent. */
export declare function formatUploadMessage(files: UploadedFile[], dir?: string): string;
