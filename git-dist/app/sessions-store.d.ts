import type { SessionListItem } from '../core/index.js';
import { type TmuxMux } from '../svelte/index.js';
export type SessionsSnapshot = Readonly<{
    rows: SessionListItem[];
    loaded: boolean;
    connected: boolean;
}>;
export type SessionsStore = {
    subscribe(run: (snapshot: SessionsSnapshot) => void): () => void;
    readonly rows: SessionListItem[];
    readonly loaded: boolean;
    readonly connected: boolean;
    dispose(): void;
};
export type CreateSessionsStoreOptions = {
    fetchSessions?: () => Promise<SessionListItem[]>;
    mux?: TmuxMux;
};
/** Protocol rows carry `activityAt` in seconds on some servers and milliseconds
 * on others. Every view that hands rows to `sessionMeta` must apply this, or one
 * host callback receives two different units depending on which view called it. */
export declare function normalizeSessionRows(rows: SessionListItem[]): SessionListItem[];
/**
 * Reconcile the optional REST snapshot with the authoritative mux stream.
 * Once the first push arrives, an older bootstrap response can never replace it.
 */
export declare function createSessionsStore(opts?: CreateSessionsStoreOptions): SessionsStore;
