import type { MuxClientMessage } from "@thumbmux/core";
import {
  createBunTmuxDriver,
  killTmuxSession,
} from "./bun-driver";
import { FileHistoryArchive } from "./history-archive";
import { createPrefsHandler, type PrefsHandlerOptions } from "./prefs-handler";
import { createSpawnHandler, type SpawnHandlerOptions } from "./spawn-handler";
import type {
  HttpAuthorizationContext,
  TokenGuard,
  TokenPrincipal,
} from "./token-guard";
import { createUploadHandler, type UploadHandlerOptions } from "./upload-handler";
import {
  TmuxWsMux,
  type HistoryArchiveLike,
  type MuxHooks,
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
  /** When supplied, authentication and authorization are enforced by every owned route. */
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

type GuardFailure = {
  ok: false;
  status: 401 | 403;
  code: string;
  message: string;
};

type GuardedRequest = {
  ok: true;
  principal: TokenPrincipal;
  setCookie?: string;
} | {
  ok: false;
  response: Response;
};

function guardFailureResponse(failure: GuardFailure): Response {
  return Response.json(
    {
      ok: false,
      status: failure.status,
      code: failure.code,
      message: failure.message,
    },
    { status: failure.status },
  );
}

function withSetCookie(response: Response, setCookie: string | undefined): Response {
  if (setCookie) response.headers.set("set-cookie", setCookie);
  return response;
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "method not allowed" },
    { status: 405, headers: { Allow: allow } },
  );
}

function authenticateAndAuthorize(
  guard: TokenGuard,
  req: Request,
  context: HttpAuthorizationContext,
): GuardedRequest {
  const auth = guard.authenticate(req);
  if (!auth.ok) return { ok: false, response: guardFailureResponse(auth) };

  const decision = guard.authorizeHttp(req, auth.principal, context);
  if (!decision.ok) {
    return {
      ok: false,
      response: withSetCookie(guardFailureResponse(decision), auth.setCookie),
    };
  }
  return {
    ok: true,
    principal: auth.principal,
    ...(auth.setCookie ? { setCookie: auth.setCookie } : {}),
  };
}

function sendAuthError(
  ws: WsLike,
  failure: Pick<GuardFailure, "status" | "code">,
): void {
  ws.send(JSON.stringify({
    type: "auth_error",
    status: failure.status,
    code: failure.code,
  }));
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
  const guard = options.guard;
  const socketPrincipals = new WeakMap<WsLike, TokenPrincipal>();
  // The websocket receives only an opaque, server-created object. Its
  // token-free principal stays in this closure until open binds the socket.
  const upgradePrincipals = new WeakMap<object, TokenPrincipal>();
  const hostHooks = options.mux?.hooks;
  const muxHooks: MuxHooks | undefined = guard
    ? {
        ...hostHooks,
        filterSessionList(sessions, ws, client) {
          const principal = socketPrincipals.get(ws);
          if (!principal) return [];
          const allowed = guard.filterSessions(
            sessions,
            principal,
            ({ name }) => name,
          );
          const projected = hostHooks?.filterSessionList
            ? hostHooks.filterSessionList(allowed, ws, client)
            : allowed;
          // The final projection remains guard-owned even when a host hook
          // accidentally returns rows outside its input.
          return guard.filterSessions(
            projected,
            principal,
            ({ name }) => name,
          );
        },
        onSocketClose(ws) {
          socketPrincipals.delete(ws);
          // TmuxWsMux performs the rest of its socket teardown after this
          // callback, so a host cleanup failure must not strand subscribers.
          try {
            hostHooks?.onSocketClose?.(ws);
          } catch {
            // Host cleanup is best effort; mux-owned cleanup must continue.
          }
        },
      }
    : hostHooks;
  const muxLog = options.log
    ? (...args: unknown[]) => options.log!(args.map(String).join(" "))
    : options.mux?.log;
  const mux = new TmuxWsMux({
    ...options.mux,
    driver,
    archive,
    pipes: options.pipes ?? null,
    ...(muxHooks ? { hooks: muxHooks } : {}),
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

      if (path === WS_PATH) {
        if (req.method !== "GET") {
          return guard ? methodNotAllowed("GET") : null;
        }
        if (!guard) {
          if (!server.upgrade(req)) {
            return new Response("websocket upgrade failed", { status: 400 });
          }
          // Bun ignores this response after hijacking the request. A non-null
          // sentinel keeps "null" unambiguously reserved for host-owned routes.
          return new Response(null, { status: 204 });
        }

        const authorization = authenticateAndAuthorize(
          guard,
          req,
          { operation: "ws-upgrade" },
        );
        if (!authorization.ok) return authorization.response;

        const socketData = Object.freeze({});
        upgradePrincipals.set(
          socketData,
          guard.sanitizePrincipal(authorization.principal),
        );
        const upgraded = server.upgrade(req, {
          data: socketData,
          ...(authorization.setCookie
            ? { headers: { "set-cookie": authorization.setCookie } }
            : {}),
        });
        if (!upgraded) {
          upgradePrincipals.delete(socketData);
          return new Response("websocket upgrade failed", { status: 400 });
        }
        // Bun ignores this response after hijacking the request. A non-null
        // sentinel keeps "null" unambiguously reserved for host-owned routes.
        return new Response(null, { status: 204 });
      }

      if (path === spawnPath) {
        if (!spawnHandler) return null;
        if (!guard) return spawnHandler(req);
        if (req.method !== "POST") return methodNotAllowed("POST");
        const authorization = authenticateAndAuthorize(
          guard,
          req,
          { operation: "sessions-spawn" },
        );
        if (!authorization.ok) return authorization.response;
        return withSetCookie(await spawnHandler(req), authorization.setCookie);
      }
      if (path === uploadPath) {
        if (!uploadHandler) return null;
        if (!guard) return uploadHandler(req);
        if (req.method !== "POST") return methodNotAllowed("POST");
        const session = url.searchParams.has("session")
          ? url.searchParams.get("session") ?? ""
          : undefined;
        const authorization = authenticateAndAuthorize(
          guard,
          req,
          {
            operation: "upload",
            ...(session !== undefined ? { session } : {}),
          },
        );
        if (!authorization.ok) return authorization.response;
        return withSetCookie(await uploadHandler(req), authorization.setCookie);
      }
      if (path === prefsPath) {
        if (!prefsHandler) return null;
        if (req.method !== "GET" && req.method !== "PUT") {
          return methodNotAllowed("GET, PUT");
        }
        if (!guard) return prefsHandler(req);
        const authorization = authenticateAndAuthorize(
          guard,
          req,
          { operation: req.method === "GET" ? "prefs-read" : "prefs-write" },
        );
        if (!authorization.ok) return authorization.response;
        return withSetCookie(await prefsHandler(req), authorization.setCookie);
      }
      if (path === sessionsPath) {
        if (req.method !== "GET") {
          return guard ? methodNotAllowed("GET") : null;
        }
        if (!guard) return Response.json(driver.listSessions());
        const authorization = authenticateAndAuthorize(
          guard,
          req,
          { operation: "sessions-list" },
        );
        if (!authorization.ok) return authorization.response;
        return withSetCookie(
          Response.json(guard.filterSessions(
            driver.listSessions(),
            authorization.principal,
            ({ name }) => name,
          )),
          authorization.setCookie,
        );
      }
      if (path.startsWith(killPrefix)) {
        if (!killEnabled) return null;
        const encodedName = path.slice(killPrefix.length);
        if (!encodedName || encodedName.includes("/")) return null;
        if (req.method !== "DELETE") {
          return guard ? methodNotAllowed("DELETE") : null;
        }
        const name = decodeSessionName(encodedName);
        if (!name) {
          return Response.json({ error: "invalid session name" }, { status: 400 });
        }
        let setCookie: string | undefined;
        if (guard) {
          const authorization = authenticateAndAuthorize(
            guard,
            req,
            { operation: "sessions-kill", session: name },
          );
          if (!authorization.ok) return authorization.response;
          setCookie = authorization.setCookie;
        }
        try {
          killTmuxSession(name);
          mux.invalidateSession(name);
          return withSetCookie(Response.json({ ok: true, name }), setCookie);
        } catch (error) {
          return withSetCookie(
            Response.json({ error: errorMessage(error) }, { status: 404 }),
            setCookie,
          );
        }
      }

      return null;
    },

    websocket: {
      message(ws, raw): void {
        const message = parseMessage(raw);
        if (!guard) {
          if (message) mux.handleMessage(message, ws);
          return;
        }
        const principal = socketPrincipals.get(ws);
        if (!principal) {
          sendAuthError(ws, { status: 401, code: "invalid_credential" });
          return;
        }
        const decision = guard.authorizeMuxMessage(message, principal);
        if (!decision.ok) {
          sendAuthError(ws, decision);
          return;
        }
        if (!message) {
          sendAuthError(ws, { status: 403, code: "forbidden_operation" });
          return;
        }
        mux.handleMessage(message, ws);
      },
      open(ws): void {
        if (guard) {
          const data = (ws as WsLike & { data?: unknown }).data;
          const principal = typeof data === "object" && data !== null
            ? upgradePrincipals.get(data)
            : undefined;
          if (!principal) {
            sendAuthError(ws, { status: 401, code: "invalid_credential" });
            return;
          }
          upgradePrincipals.delete(data as object);
          socketPrincipals.set(ws, principal);
        }
        mux.subscribeSessions(ws);
      },
      close(ws): void {
        if (guard) {
          socketPrincipals.delete(ws);
          const data = (ws as WsLike & { data?: unknown }).data;
          if (typeof data === "object" && data !== null) {
            upgradePrincipals.delete(data);
          }
        }
        mux.unsubscribeAll(ws);
      },
      drain(ws): void {
        mux.handleDrain(ws);
      },
    },
  };
}
