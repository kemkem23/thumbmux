import type { MuxClientMessage } from "@thumbmux/core";
import {
  createBunTmuxDriver,
  killTmuxSession,
} from "./bun-driver";
import { FileHistoryArchive } from "./history-archive";
import { createPrefsHandler, type PrefsHandlerOptions } from "./prefs-handler";
import { createSpawnHandler, type SpawnHandlerOptions } from "./spawn-handler";
import type { TokenGuard } from "./token-guard";
import { createUploadHandler, type UploadHandlerOptions } from "./upload-handler";
import {
  TmuxWsMux,
  type HistoryArchiveLike,
  type PipeManagerLike,
  type TmuxDriver,
  type TmuxWsMuxOptions,
  type WsLike,
} from "./ws-mux";

export interface AppRoutesOptions {
  /** Reference Bun driver by default; one instance is shared by every route. */
  driver?: TmuxDriver;
  /** Undefined creates a private per-run archive; null disables history. */
  archive?: HistoryArchiveLike | null;
  pipes?: PipeManagerLike;
  /** Accepted here for S2 to enforce; S1 deliberately preserves unguarded behavior. */
  guard?: TokenGuard;
  /** Enabled by default. false leaves the path to the host. */
  spawn?: SpawnHandlerOptions | false;
  /** Supply handler options to enable; false leaves the path to the host. */
  upload?: UploadHandlerOptions | false;
  /** Supply handler options to enable; false leaves the path to the host. */
  prefs?: PrefsHandlerOptions | false;
  /** Enabled by default. */
  kill?: { enabled: boolean };
  /** REST route prefix. The websocket remains fixed at /ws/tmux. */
  basePath?: string;
  /** Polling, profile, hook, compression, and backpressure overrides. */
  mux?: Partial<TmuxWsMuxOptions>;
  log?: (line: string) => void;
}

export interface AppRoutes<WS> {
  fetch(
    req: Request,
    server: { upgrade(req: Request, opts?: unknown): boolean },
  ): Promise<Response | null>;
  websocket: {
    message(ws: WS, raw: string | Uint8Array): void;
    open(ws: WS): void;
    close(ws: WS): void;
    drain(ws: WS): void;
  };
  mux: TmuxWsMux;
}

const WS_PATH = "/ws/tmux";
const decoder = new TextDecoder();

function normalizeBasePath(value: string | undefined): string {
  const path = (value ?? "/api").trim();
  if (!path || path === "/") return "";
  const rooted = path.startsWith("/") ? path : `/${path}`;
  return rooted.replace(/\/+$/, "");
}

function parseMessage(raw: string | Uint8Array): MuxClientMessage | null {
  try {
    const parsed: unknown = JSON.parse(
      typeof raw === "string" ? raw : decoder.decode(raw),
    );
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as MuxClientMessage;
  } catch {
    return null;
  }
}

function decodeSessionName(encoded: string): string | null {
  if (!encoded || encoded.includes("/")) return null;
  try {
    const name = decodeURIComponent(encoded);
    return name && !name.includes("/") ? name : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Compose the reference mux and its HTTP/WebSocket routes without owning the
 * listener. A null fetch result means the host still owns that request.
 */
export function createAppRoutes(options: AppRoutesOptions = {}): AppRoutes<WsLike> {
  const driver = options.driver ?? createBunTmuxDriver();
  const archive = options.archive === undefined
    ? new FileHistoryArchive({})
    : options.archive;
  const muxLog = options.log
    ? (...args: unknown[]) => options.log!(args.map(String).join(" "))
    : options.mux?.log;
  const mux = new TmuxWsMux({
    ...options.mux,
    driver,
    archive,
    pipes: options.pipes ?? null,
    ...(muxLog ? { log: muxLog } : {}),
  });

  const spawnHandler = options.spawn === false
    ? null
    : createSpawnHandler({ ...(options.spawn ?? {}), driver });
  const uploadHandler = options.upload === undefined || options.upload === false
    ? null
    : createUploadHandler(options.upload);
  const prefsHandler = options.prefs === undefined || options.prefs === false
    ? null
    : createPrefsHandler(options.prefs);
  const killEnabled = options.kill?.enabled !== false;
  const basePath = normalizeBasePath(options.basePath);
  const spawnPath = `${basePath}/spawn`;
  const uploadPath = `${basePath}/upload`;
  const prefsPath = `${basePath}/prefs`;
  const sessionsPath = `${basePath}/sessions`;
  const killPrefix = `${sessionsPath}/`;

  return {
    mux,

    async fetch(req, server): Promise<Response | null> {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === "GET" && path === WS_PATH) {
        if (!server.upgrade(req)) {
          return new Response("websocket upgrade failed", { status: 400 });
        }
        // Bun ignores this response after hijacking the request. A non-null
        // sentinel keeps "null" unambiguously reserved for host-owned routes.
        return new Response(null, { status: 204 });
      }

      if (path === spawnPath) {
        return spawnHandler ? spawnHandler(req) : null;
      }
      if (path === uploadPath) {
        return uploadHandler ? uploadHandler(req) : null;
      }
      if (path === prefsPath) {
        if (!prefsHandler) return null;
        if (req.method !== "GET" && req.method !== "PUT") {
          return Response.json(
            { error: "method not allowed" },
            { status: 405, headers: { Allow: "GET, PUT" } },
          );
        }
        return prefsHandler(req);
      }
      if (req.method === "GET" && path === sessionsPath) {
        return Response.json(driver.listSessions());
      }
      if (req.method === "DELETE" && path.startsWith(killPrefix)) {
        if (!killEnabled) return null;
        const encodedName = path.slice(killPrefix.length);
        if (!encodedName || encodedName.includes("/")) return null;
        const name = decodeSessionName(encodedName);
        if (!name) {
          return Response.json({ error: "invalid session name" }, { status: 400 });
        }
        try {
          killTmuxSession(name);
          mux.invalidateSession(name);
          return Response.json({ ok: true, name });
        } catch (error) {
          return Response.json({ error: errorMessage(error) }, { status: 404 });
        }
      }

      return null;
    },

    websocket: {
      message(ws, raw): void {
        const message = parseMessage(raw);
        if (message) mux.handleMessage(message, ws);
      },
      open(ws): void {
        mux.subscribeSessions(ws);
      },
      close(ws): void {
        mux.unsubscribeAll(ws);
      },
      drain(ws): void {
        mux.handleDrain(ws);
      },
    },
  };
}
