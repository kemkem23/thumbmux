export type UploadHandlerOptions = {
    /** absolute or cwd-relative directory to store files in (created if absent) */
    dir: string;
    maxFiles?: number;
    maxBytesPerFile?: number;
};
export declare function createUploadHandler(opts: UploadHandlerOptions): (req: Request) => Promise<Response>;
