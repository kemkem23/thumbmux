import type { LaunchSpec, SessionListItem, SubmitAgent } from "@thumbmux/core";

export const DEMO_SUBMIT_AGENTS = new Set<SubmitAgent>([
  "generic",
  "claude",
  "codex",
  "grok",
]);

export function demoSubmitAgent(agent: unknown): SubmitAgent {
  if (agent === "cc") return "claude";
  if (agent === "codex" || agent === "grok") return agent;
  return "generic";
}

export type DemoSessionMetadata = {
  submitAgent: SubmitAgent;
  altScreenMouse: boolean;
};

const DEMO_SESSION_NAME = /^demo-([A-Za-z0-9]{1,12})-(generic|claude|codex|grok)-([01])-([1-9]\d*)$/;

/** Keep the demo's existing direct-command spawn behavior while carrying host metadata. */
export function demoSpawnPayload(spec: LaunchSpec) {
  return {
    command: spec.command,
    worktree: spec.worktree,
    agent: spec.agent,
    // `presetId` is authoritative in createSpawnHandler and would rebuild the
    // already composed command. Keep this demo-only hint out of that namespace.
    demoPresetId: spec.presetId,
  };
}

export function createDemoSessionPolicy(runToken: string) {
  const runId = runToken.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "run";
  let counter = 0;

  return {
    allocate(context: {
      payload: { agent?: unknown; demoPresetId?: unknown };
      existing: ReadonlySet<string>;
    }): string {
      const submitAgent = demoSubmitAgent(context.payload.agent);
      const altScreenMouse = context.payload.demoPresetId === "alt-screen-mouse";
      let name = "";
      do {
        name = `demo-${runId}-${submitAgent}-${altScreenMouse ? 1 : 0}-${++counter}`;
      } while (context.existing.has(name));
      return name;
    },
    project(sessions: readonly SessionListItem[]): readonly SessionListItem[] {
      return sessions.map((session) => {
        const policy = demoSessionMetadataFromName(session.name);
        return policy
          ? {
              ...session,
              demoSubmitAgent: policy.submitAgent,
              demoAltScreenMouse: policy.altScreenMouse,
            }
          : session;
      });
    },
  };
}

/** Decode policy from a server-assigned name, including names from prior runs. */
export function demoSessionMetadataFromName(name: unknown): DemoSessionMetadata | null {
  if (typeof name !== "string") return null;
  const match = DEMO_SESSION_NAME.exec(name);
  if (!match) return null;
  return {
    submitAgent: match[2] as SubmitAgent,
    altScreenMouse: match[3] === "1",
  };
}

/** The public demo never accepts a caller-selected name: policy is name-encoded. */
export function validateDemoSpawnCwd(
  _cwd: string,
  payload: { name?: unknown },
): true | string {
  return payload.name === undefined
    ? true
    : "demo session names are assigned by the server";
}

export function sessionMetadataFromRows(rows: readonly unknown[]): {
  agents: Record<string, SubmitAgent>;
  altScreens: Record<string, boolean>;
} {
  const agents: Record<string, SubmitAgent> = {};
  const altScreens: Record<string, boolean> = {};
  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (typeof row.name !== "string" || !row.name) continue;
    if (
      typeof row.demoSubmitAgent === "string"
      && DEMO_SUBMIT_AGENTS.has(row.demoSubmitAgent as SubmitAgent)
    ) {
      agents[row.name] = row.demoSubmitAgent as SubmitAgent;
    }
    if (typeof row.demoAltScreenMouse === "boolean") {
      altScreens[row.name] = row.demoAltScreenMouse;
    }
  }
  return { agents, altScreens };
}

type DemoSessionsMux = {
  onSessions(callback: (rows: unknown[]) => void): () => void;
};

/**
 * Decorate every live-session subscription without changing the receiver used
 * by the underlying mux's methods and private state.
 */
export function createDemoSessionsMux<T extends DemoSessionsMux>(
  source: T,
  options: {
    delayMs: number;
    hydrate(rows: readonly unknown[]): void;
  },
): T {
  const delayMs = Number.isFinite(options.delayMs)
    ? Math.max(0, options.delayMs)
    : 0;
  const onSessions: DemoSessionsMux["onSessions"] = (callback) => {
    let active = true;
    let delivered = false;
    let pending: unknown[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = source.onSessions((rows) => {
      if (!active) return;
      options.hydrate(rows);
      if (delayMs === 0 || delivered) {
        callback(rows);
        return;
      }
      pending = rows;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!active) return;
        delivered = true;
        callback(pending);
      }, delayMs);
    });
    return () => {
      if (!active) return;
      active = false;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  };

  return new Proxy(source, {
    get(target, property) {
      if (property === "onSessions") return onSessions;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });
}
