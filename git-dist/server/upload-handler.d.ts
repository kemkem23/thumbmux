export type UploadHandlerOptions = {
    /** absolute or cwd-relative directory to store files in (created if absent) */
    dir: string;
    maxFiles?: number;
    maxBytesPerFile?: number;
    /**
     * Optional cap on the sum of all part sizes in one request.
     * Default undefined = unlimited (today's behaviour). When set and exceeded,
     * rejects with 413 after the count and per-file checks (per-file wins).
     */
    maxTotalBytes?: number;
};
export declare function createUploadHandler(opts: UploadHandlerOptions): (req: Request) => Promise<Response>;
