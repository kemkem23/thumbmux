export type UploadHandlerOptions = {
    /** absolute or cwd-relative directory to store files in (created if absent) */
    dir: string;
    maxFiles?: number;
    maxBytesPerFile?: number;
    /**
     * Optional cap on decoded payload bytes across every part in one request.
     * String values count as UTF-8; file/blob values use their byte size. The
     * platform parses multipart data before these decoded values are available.
     * Default undefined = unlimited. When set and exceeded, rejects with 413
     * after the count and per-file checks (per-file wins).
     */
    maxTotalBytes?: number;
};
export declare function createUploadHandler(opts: UploadHandlerOptions): (req: Request) => Promise<Response>;
