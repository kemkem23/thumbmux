/**
 * Reference TmuxDriver for Bun — talks to a local tmux over its CLI. This is
 * what the demo uses; production hosts usually bring richer drivers (shared
 * activity caches, worktree spawning, memory-scoped launches…) but this one
 * is complete and honest: every TmuxWsMux feature works against it.
 */
import type { RawCursorState, TmuxDriver } from "./ws-mux";

const LARGE_INPUT_THRESHOLD_BYTES = 8 * 1024;

export type TmuxTargetMode = "exact" | "legacy";

export type TmuxTargetOptions = {
  /**
   * `exact` (default) prevents tmux from falling through to prefix/fnmatch
   * resolution. `legacy` passes names through unchanged for hosts that
   * deliberately depend on tmux's native target matching.
   */
  targetMode?: TmuxTargetMode;
};

/** Exact target-session syntax. A name beginning with `=` is escaped by the
 * added marker: `=agent` becomes `==agent`. */
export function exactTmuxTarget(name: string): string {
  return `=${name}`;
}

/**
 * Exact target-pane/window syntax. Pane operations such as `send-keys` and
 * `capture-pane` reject a bare exact-session target (`=name`), even though
 * `kill-session` accepts it. Keep both the leading `=` and trailing `:`:
 * without `=`, tmux may silently prefix-match a different session.
 */
export function exactTmuxPaneTarget(name: string): string {
  return `${exactTmuxTarget(name)}:`;
}

function targetResolvers(options: TmuxTargetOptions): {
  pane(name: string): string;
  session(name: string): string;
} {
  const legacy = options.targetMode === "legacy";
  return {
    pane: legacy ? (name) => name : exactTmuxPaneTarget,
    session: legacy ? (name) => name : exactTmuxTarget,
  };
}

function run(args: string[]): string {
  const p = Bun.spawnSync(["tmux", ...args]);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim() || `tmux ${args[0]} failed`);
  return p.stdout.toString();
}

function runWithStdin(args: string[], stdin: Uint8Array): string {
  const p = Bun.spawnSync(["tmux", ...args], { stdin, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim() || `tmux ${args[0]} failed`);
  return p.stdout.toString();
}

function sendLargeInput(target: string, bytes: Uint8Array) {
  const bufferName = `thumbmux-input-${crypto.randomUUID()}`;
  try {
    runWithStdin(["load-buffer", "-b", bufferName, "-"], bytes);
    // -r preserves LF bytes instead of translating them to tmux's separator
    // (CR by default), keeping this path byte-identical to send-keys -l.
    run(["paste-buffer", "-d", "-r", "-b", bufferName, "-t", target]);
  } finally {
    // -d covers successful pastes; this also clears a buffer if loading or
    // pasting fails midway.
    try { run(["delete-buffer", "-b", bufferName]); } catch { /* best effort */ }
  }
}

function parseCursorLine(line: string): RawCursorState | null {
  const [x, y, h, flag, inMode] = line.split("|").map((v) => Number(v));
  if (![x, y, h].every(Number.isFinite)) return null;
  return { x: x!, y: y!, paneHeight: h!, visible: flag === 1 && inMode === 0 };
}

export function createBunTmuxDriver(options: TmuxTargetOptions = {}): TmuxDriver {
  // Refreshed by getSessionActivity(), which the mux already calls once per
  // poll. listSessions() reuses this sample so adding activityAt never adds a
  // second list-windows invocation to a poll.
  let latestActivity = new Map<string, number>();
  const target = targetResolvers(options);

  return {
    listSessions() {
      try {
        return run(["list-sessions", "-F", "#{session_name}|#{session_created}|#{session_windows}|#{session_attached}"])
          .trim().split("\n").filter(Boolean).map((line) => {
            const [name, created, windows, attached] = line.split("|");
            return {
              name,
              created,
              windows: Number(windows) || 1,
              attached: attached === "1",
              activityAt: latestActivity.get(name!) ?? 0,
            };
          });
      } catch {
        return []; // no server running yet
      }
    },
    async capturePane(session, opts) {
      const args = ["capture-pane", "-t", target.pane(session), "-p", "-e"];
      if (!opts.currentPaneOnly && typeof opts.startLine === "number") {
        args.push("-S", String(opts.startLine));
      }
      const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      if ((await p.exited) !== 0) throw new Error(`capture-pane failed for ${session}`);
      return out;
    },
    sendKeys(session, data) {
      const bytes = new TextEncoder().encode(data);
      // NUL cannot be represented in an argv entry (Bun/execve rejects it),
      // so even a one-byte Ctrl-Space must travel through load-buffer stdin.
      if (bytes.byteLength <= LARGE_INPUT_THRESHOLD_BYTES && !data.includes("\0")) {
        run(["send-keys", "-t", target.pane(session), "-l", "--", data]);
        return;
      }
      sendLargeInput(target.pane(session), bytes);
    },
    getSessionActivity() {
      // window_activity, NOT session_activity: the session timestamp freezes
      // for detached sessions (nobody attached = no client activity), so a
      // pane writing output would never re-trigger the poll gate and hub
      // thumbnails froze (fleet finding). Window activity bumps on output.
      const map = new Map<string, number>();
      try {
        for (const line of run(["list-windows", "-a", "-F", "#{session_name}|#{window_activity}"]).trim().split("\n")) {
          const [name, at] = line.split("|");
          if (!name) continue;
          const t = Number(at) || 0;
          if (t > (map.get(name) ?? 0)) map.set(name, t);
        }
      } catch { /* no server */ }
      latestActivity = map;
      return map;
    },
    getHistoryLimit() {
      try {
        const m = run(["show-options", "-g", "history-limit"]).match(/(\d+)/);
        return m ? Number(m[1]) : 2000;
      } catch { return 2000; }
    },
    setSessionHistoryLimit(session, limit) {
      run(["set-option", "-t", target.pane(session), "history-limit", String(limit)]);
    },
    resizeWindow(session, cols, rows) {
      run(["resize-window", "-t", target.pane(session), "-x", String(cols), "-y", String(rows)]);
    },
    hash(content) {
      return Bun.hash(content).toString(36);
    },
    async getCursor(session) {
      try {
        const out = run(["display-message", "-t", target.pane(session), "-p",
          "#{cursor_x}|#{cursor_y}|#{pane_height}|#{cursor_flag}|#{pane_in_mode}"]).trim();
        return parseCursorLine(out);
      } catch {
        return null;
      }
    },
    async captureWithCursor(session, opts) {
      // ONE tmux invocation for both commands: the server runs them back to
      // back, so the (content, cursor) pair cannot desync the way two
      // separate calls can during a TUI repaint. display-message goes first —
      // its single line is trivially split off the top of the output.
      const paneTarget = target.pane(session);
      const args = ["display-message", "-t", paneTarget, "-p",
        "#{cursor_x}|#{cursor_y}|#{pane_height}|#{cursor_flag}|#{pane_in_mode}",
        ";", "capture-pane", "-t", paneTarget, "-p", "-e"];
      if (!opts.currentPaneOnly && typeof opts.startLine === "number") {
        args.push("-S", String(opts.startLine));
      }
      const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      if ((await p.exited) !== 0) throw new Error(`capture-pane failed for ${session}`);
      const nl = out.indexOf("\n");
      const cursorLine = nl === -1 ? out : out.slice(0, nl);
      const content = nl === -1 ? "" : out.slice(nl + 1);
      const lines = content.replace(/\n$/, "").split("\n");
      let last = lines.length;
      while (last > 0 && (lines[last - 1] ?? "").trim() === "") last--;
      return { content, cursor: parseCursorLine(cursorLine.trim()), trailingBlanks: lines.length - last };
    },
  };
}

/** Spawn a session (optionally running a command inside a fresh shell). */
export function spawnTmuxSession(
  name: string,
  cwd: string,
  command?: string,
  options: TmuxTargetOptions = {},
) {
  const target = targetResolvers(options).pane(name);
  run(["new-session", "-d", "-s", name, "-c", cwd]);
  if (command) run(["send-keys", "-t", target, "-l", "--", command]);
  if (command) run(["send-keys", "-t", target, "Enter"]);
}

export function killTmuxSession(name: string, options: TmuxTargetOptions = {}) {
  run(["kill-session", "-t", targetResolvers(options).session(name)]);
}
