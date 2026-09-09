export type QueryParamNav = {
    readonly session: string | null;
    subscribe(run: (session: string | null) => void): () => void;
    openSession(name: string): void;
    showHub(): void;
    dispose(): void;
};
/** Browser navigation for a single-page shell, backed by one query parameter. */
export declare function createQueryParamNav(param?: string): QueryParamNav;
