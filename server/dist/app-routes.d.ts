import type { SessionListItem } from "@thumbmux/core";
import { type PrefsHandlerOptions } from "./prefs-handler";
import { type SpawnHandlerOptions } from "./spawn-handler";
import type { TokenGuard } from "./token-guard";
import { type UploadHandlerOptions } from "./upload-handler";
import { TmuxWsMux, type HistoryArchiveLike, type PipeManagerLike, type TmuxDriver, type TmuxWsMuxOptions, type WsLike } from "./ws-mux";
export interface AppRoutesOptions {
    /** Reference Bun driver by default; one instance is shared by every route. */
    driver?: TmuxDriver;
    /** Undefined creates a private per-run archive; null disables history. */
    archive?: HistoryArchiveLike | null;
    pipes?: PipeManagerLike;
    /** When supplied, authentication and authorization are enforced by every owned route. */
    guard?: TokenGuard;
    /** Enabled by default. false leaves the path to the host. */
    spawn?: SpawnHandlerOptions | false;
    /** Supply handler options to enable; false leaves the path to the host. */
    upload?: UploadHandlerOptions | false;
    /** Supply handler options to enable; false leaves the path to the host. */
    prefs?: PrefsHandlerOptions | false;
    /** Enabled by default. */
    kill?: {
        enabled: boolean;
    };
    /** REST route prefix. The websocket remains fixed at /ws/tmux. */
    basePath?: string;
    /** Polling, profile, hook, compression, and backpressure overrides. */
    mux?: Partial<TmuxWsMuxOptions>;
    /**
     * Transport-neutral, synchronous presentation projection applied to HTTP
     * and WebSocket session-list deliveries. Do not mutate the input.
     * Omitted = identity.
     */
    projectSessionList?: (sessions: readonly SessionListItem[]) => readonly SessionListItem[];
    log?: (line: string) => void;
}
export interface AppRoutes<WS> {
    fetch(req: Request, server: {
        upgrade(req: Request, opts?: unknown): boolean;
    }): Promise<Response | null>;
    websocket: {
        message(ws: WS, raw: string | Uint8Array): void;
        open(ws: WS): void;
        close(ws: WS): void;
        drain(ws: WS): void;
    };
    mux: TmuxWsMux;
}
/**
 * Compose the reference mux and its HTTP/WebSocket routes without owning the
 * listener. A null fetch result means the host still owns that request.
 */
export declare function createAppRoutes(options?: AppRoutesOptions): AppRoutes<WsLike>;
