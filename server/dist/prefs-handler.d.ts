export type PrefsHandlerOptions = {
    /** One JSON file shared by every request in this trusted tenant. */
    file: string;
};
export declare function createPrefsHandler(opts: PrefsHandlerOptions): (req: Request) => Promise<Response>;
