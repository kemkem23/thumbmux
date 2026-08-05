/**
 * Turnkey tmux spawn endpoint. The handler accepts either the full LaunchSpec
 * emitted by LaunchSheet or the demo's smaller { command, worktree } payload,
 * resolves a collision-free name and cwd, then delegates the actual tmux
 * creation to spawnTmuxSession.
 *
 * Known presets are rebuilt server-side with buildLaunchCommand so submitted
 * command text cannot override the configured preset. A direct command remains
 * supported because LaunchSheet also accepts host-defined presets and the demo
 * has historically forwarded their already-built command.
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_LAUNCH_PRESETS,
  buildLaunchCommand,
  type LaunchPreset,
  type LaunchSpec,
  type SessionListItem,
  type SessionListRow,
} from "@thumbmux/core";
import { createBunTmuxDriver, spawnTmuxSession } from "./bun-driver";
import type { TmuxDriver } from "./ws-mux";

type MaybePromise<T> = T | Promise<T>;

/** LaunchSheet fields plus the host-owned session placement fields. */
export type SpawnPayload = Partial<LaunchSpec> & {
  /** Exact requested tmux name. Omit to let the handler allocate one. */
  name?: string;
  /** Cwd override. Omit to use the handler's configured/default cwd. */
  cwd?: string;
  /** On an explicit-name collision, append a numeric suffix instead of 409. */
  autoName?: boolean;
};

export type SpawnNameContext = {
  payload: SpawnPayload;
  existing: ReadonlySet<string>;
};

export type SpawnWorktreeContext = {
  name: string;
  cwd: string;
  payload: SpawnPayload;
};

export type SpawnWorktreeCleanupContext = SpawnWorktreeContext & {
  worktreeCwd: string;
  cause: unknown;
};

export type SpawnHandlerOptions<
  SessionRow extends SessionListRow = SessionListItem,
> = {
  /** Session inventory used for collision checks. Defaults to the Bun driver. */
  driver?: Pick<TmuxDriver<SessionRow>, "listSessions">;
  /** Static fallback cwd, or an authoritative host resolver. Defaults to process.cwd(). */
  cwd?: string | ((payload: SpawnPayload) => MaybePromise<string>);
  /** Server-authoritative presets. Defaults to DEFAULT_LAUNCH_PRESETS. */
  presets?: readonly LaunchPreset[];
  /** Prefix for the default allocator (prefix-1, prefix-2, ...). */
  namePrefix?: string;
  /** Host allocator used when the payload omits name. */
  generateName?: (context: SpawnNameContext) => MaybePromise<string>;
  /** Optional allowed-root/policy check after the path is resolved and statted. */
  validateCwd?: (
    cwd: string,
    payload: SpawnPayload,
  ) => MaybePromise<boolean | string | void>;
  /**
   * Opt-in worktree creator. It must create/resolve the worktree and return its
   * cwd; thumbmux never assumes git or runs `git worktree` itself.
   */
  prepareWorktree?: (context: SpawnWorktreeContext) => MaybePromise<string>;
  /**
   * Required alongside prepareWorktree. Rolls back its returned path after
   * final-cwd validation or spawning fails, before any auto-name retry.
   */
  cleanupWorktree?: (context: SpawnWorktreeCleanupContext) => MaybePromise<void>;
  /** Spawn implementation; defaults to spawnTmuxSession. Useful for adapters/tests. */
  spawn?: (name: string, cwd: string, command?: string) => MaybePromise<void>;
};

/** A hook can throw this to preserve a deliberate HTTP error status. */
export class SpawnHandlerError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SpawnHandlerError";
    this.status = status;
  }
}

const SESSION_NAME_RE = /^[A-Za-z0-9_-]+$/;
const STRING_FIELDS = [
  "name",
  "cwd",
  "presetId",
  "agent",
  "permission",
  "model",
  "command",
] as const;
const BOOLEAN_FIELDS = ["worktree", "autoName"] as const;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDuplicateSessionError(error: unknown, reservedName: string): boolean {
  return errorMessage(error).trim().toLowerCase()
    === `duplicate session: ${reservedName}`.toLowerCase();
}

function parsePayload(value: unknown): SpawnPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SpawnHandlerError(400, "expected a JSON object");
  }
  const payload = value as Record<string, unknown>;
  for (const field of STRING_FIELDS) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") {
      throw new SpawnHandlerError(400, `${field} must be a string`);
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (payload[field] !== undefined && typeof payload[field] !== "boolean") {
      throw new SpawnHandlerError(400, `${field} must be a boolean`);
    }
  }
  return payload as SpawnPayload;
}

function assertSessionName(name: string, source: "payload" | "host"): string {
  const normalized = name.trim();
  if (!normalized || !SESSION_NAME_RE.test(normalized)) {
    const detail = "use only letters, numbers, _ and -";
    throw new SpawnHandlerError(
      source === "payload" ? 400 : 500,
      `invalid tmux session name${source === "host" ? " from host allocator" : ""}: ${detail}`,
    );
  }
  return normalized;
}

function withNumericSuffix(base: string, taken: ReadonlySet<string>, start = 2): string {
  for (let suffix = start; suffix < 1_000_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new SpawnHandlerError(500, `could not allocate a unique session name for ${base}`);
}

async function resolveDirectory(
  raw: unknown,
  payload: SpawnPayload,
  validateCwd?: SpawnHandlerOptions["validateCwd"],
): Promise<string> {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new SpawnHandlerError(400, "cwd must be a non-empty string");
  }

  let cwd: string;
  try {
    cwd = resolve(raw);
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new SpawnHandlerError(400, `invalid cwd: ${errorMessage(error)}`);
  }

  if (validateCwd) {
    const verdict = await validateCwd(cwd, payload);
    if (verdict === false) throw new SpawnHandlerError(400, "cwd rejected by host policy");
    if (typeof verdict === "string") throw new SpawnHandlerError(400, verdict);
  }
  return cwd;
}

export function createSpawnHandler<
  SessionRow extends SessionListRow = SessionListItem,
>(opts: SpawnHandlerOptions<SessionRow> = {}) {
  const driver = opts.driver ?? createBunTmuxDriver();
  const presets = opts.presets ?? DEFAULT_LAUNCH_PRESETS;
  const spawn = opts.spawn ?? spawnTmuxSession;
  const reservedNames = new Set<string>();

  // Serialise only allocation/listing. Worktree creation and tmux startup can
  // proceed in parallel once each request owns a reservation.
  let allocationTail: Promise<void> = Promise.resolve();
  async function reserveName(
    payload: SpawnPayload,
    preset: LaunchPreset | null,
    blockedNames: ReadonlySet<string>,
  ): Promise<string> {
    const previous = allocationTail;
    let release!: () => void;
    allocationTail = new Promise<void>((done) => { release = done; });
    await previous;

    try {
      const taken = new Set(
        driver.listSessions()
          .map((session) => session.name)
          .filter((name): name is string => typeof name === "string" && !!name),
      );
      for (const name of reservedNames) taken.add(name);
      for (const name of blockedNames) taken.add(name);

      const requested = payload.name;
      let name: string;
      if (requested !== undefined) {
        name = assertSessionName(requested, "payload");
        if (taken.has(name)) {
          if (payload.autoName !== true) {
            throw new SpawnHandlerError(409, `tmux session already exists: ${name}`);
          }
          name = withNumericSuffix(name, taken);
        }
      } else if (opts.generateName) {
        name = assertSessionName(
          await opts.generateName({ payload, existing: taken }),
          "host",
        );
        if (taken.has(name)) name = withNumericSuffix(name, taken);
      } else {
        const rawPrefix = opts.namePrefix ?? preset?.agent ?? payload.agent ?? "sh";
        const prefix = assertSessionName(rawPrefix || "sh", "host");
        name = `${prefix}-1`;
        if (taken.has(name)) name = withNumericSuffix(prefix, taken, 2);
      }

      reservedNames.add(name);
      return name;
    } finally {
      release();
    }
  }

  return async function handleSpawn(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return jsonError(405, "method not allowed");
    }

    let reservedName: string | null = null;
    try {
      let rawPayload: unknown;
      try {
        rawPayload = await req.json();
      } catch {
        throw new SpawnHandlerError(400, "expected valid JSON");
      }
      const payload = parsePayload(rawPayload);

      let preset: LaunchPreset | null = null;
      let command = typeof payload.command === "string" && payload.command.length > 0
        ? payload.command
        : undefined;
      let worktree = payload.worktree === true;
      if (payload.presetId !== undefined) {
        preset = presets.find((candidate) => candidate.id === payload.presetId) ?? null;
        if (!preset) throw new SpawnHandlerError(400, `unknown launch preset: ${payload.presetId}`);
        command = buildLaunchCommand(preset, payload.permission, payload.model) || undefined;
        worktree = !!preset.worktree;
      }
      if (command?.includes("\0")) {
        throw new SpawnHandlerError(
          preset ? 500 : 400,
          preset
            ? "launch preset command must not contain NUL"
            : "command must not contain NUL",
        );
      }

      const rawCwd = typeof opts.cwd === "function"
        ? await opts.cwd(payload)
        : payload.cwd ?? opts.cwd ?? process.cwd();
      const baseCwd = await resolveDirectory(rawCwd, payload, opts.validateCwd);
      const collidedNames = new Set<string>();
      const canAutoName = payload.name === undefined || payload.autoName === true;
      const prepareWorktree = opts.prepareWorktree;
      const cleanupWorktree = opts.cleanupWorktree;
      if (worktree && !prepareWorktree) {
        throw new SpawnHandlerError(400, "worktree requested but no prepareWorktree hook is configured");
      }
      if (worktree && !cleanupWorktree) {
        throw new SpawnHandlerError(400, "worktree requested but no cleanupWorktree hook is configured");
      }

      for (let attempt = 0; attempt < 100; attempt += 1) {
        reservedName = await reserveName(payload, preset, collidedNames);
        let cwd = baseCwd;
        let worktreeCwd: string | null = null;

        try {
          if (worktree) {
            const preparedCwd = await prepareWorktree!({
              name: reservedName,
              cwd,
              payload,
            });
            // Remember the returned path before validation so a hook that
            // created a directory but returned a non-directory can still be
            // rolled back.
            if (preparedCwd.trim()) worktreeCwd = resolve(preparedCwd);
            cwd = await resolveDirectory(preparedCwd, payload, opts.validateCwd);
            worktreeCwd = cwd;
          }

          await spawn(reservedName, cwd, command);
        } catch (error) {
          if (worktreeCwd) {
            await cleanupWorktree!({
              name: reservedName,
              cwd: baseCwd,
              payload,
              worktreeCwd,
              cause: error,
            });
          }
          // A hook's deliberate HTTP status always wins over text that merely
          // resembles tmux's duplicate-session diagnostic.
          if (error instanceof SpawnHandlerError) throw error;
          if (!isDuplicateSessionError(error, reservedName)) throw error;
          if (!canAutoName) {
            throw new SpawnHandlerError(409, `tmux session already exists: ${reservedName}`);
          }

          // Another tmux client (or another handler instance) won the race
          // after listSessions(). Remember that name even if the next list is
          // stale, release our local reservation, and allocate a new suffix.
          collidedNames.add(reservedName);
          reservedNames.delete(reservedName);
          reservedName = null;
          continue;
        }

        return Response.json({ ok: true, name: reservedName }, { status: 201 });
      }

      throw new SpawnHandlerError(500, "could not allocate a unique tmux session name after 100 attempts");
    } catch (error) {
      if (error instanceof SpawnHandlerError) {
        return jsonError(error.status, error.message);
      }
      return jsonError(500, errorMessage(error));
    } finally {
      if (reservedName) reservedNames.delete(reservedName);
    }
  };
}
