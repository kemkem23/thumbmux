/**
 * Reference TmuxDriver for Bun — talks to a local tmux over its CLI. This is
 * what the demo uses; production hosts usually bring richer drivers (shared
 * activity caches, worktree spawning, memory-scoped launches…) but this one
 * is complete and honest: every TmuxWsMux feature works against it.
 */
import type { TmuxDriver } from "./ws-mux";

function run(args: string[]): string {
  const p = Bun.spawnSync(["tmux", ...args]);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim() || `tmux ${args[0]} failed`);
  return p.stdout.toString();
}

export function createBunTmuxDriver(): TmuxDriver {
  return {
    listSessions() {
      try {
        return run(["list-sessions", "-F", "#{session_name}|#{session_created}|#{session_windows}|#{session_attached}"])
          .trim().split("\n").filter(Boolean).map((line) => {
            const [name, created, windows, attached] = line.split("|");
            return { name, created, windows: Number(windows) || 1, attached: attached === "1" };
          });
      } catch {
        return []; // no server running yet
      }
    },
    async capturePane(session, opts) {
      const args = ["capture-pane", "-t", session, "-p", "-e"];
      if (!opts.currentPaneOnly && typeof opts.startLine === "number") {
        args.push("-S", String(opts.startLine));
      }
      const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      if ((await p.exited) !== 0) throw new Error(`capture-pane failed for ${session}`);
      return out;
    },
    sendKeys(session, data) {
      run(["send-keys", "-t", session, "-l", "--", data]);
    },
    getSessionActivity() {
      const map = new Map<string, number>();
      try {
        for (const line of run(["list-sessions", "-F", "#{session_name}|#{session_activity}"]).trim().split("\n")) {
          const [name, at] = line.split("|");
          if (name) map.set(name, Number(at) || 0);
        }
      } catch { /* no server */ }
      return map;
    },
    getHistoryLimit() {
      try {
        const m = run(["show-options", "-g", "history-limit"]).match(/(\d+)/);
        return m ? Number(m[1]) : 2000;
      } catch { return 2000; }
    },
    setSessionHistoryLimit(session, limit) {
      run(["set-option", "-t", session, "history-limit", String(limit)]);
    },
    resizeWindow(session, cols, rows) {
      run(["resize-window", "-t", session, "-x", String(cols), "-y", String(rows)]);
    },
    hash(content) {
      return Bun.hash(content).toString(36);
    },
    async getCursor(session) {
      try {
        const out = run(["display-message", "-t", session, "-p",
          "#{cursor_x}|#{cursor_y}|#{pane_height}|#{cursor_flag}|#{pane_in_mode}"]).trim();
        const [x, y, h, flag, inMode] = out.split("|").map((v) => Number(v));
        if (![x, y, h].every(Number.isFinite)) return null;
        return { x: x!, y: y!, paneHeight: h!, visible: flag === 1 && inMode === 0 };
      } catch {
        return null;
      }
    },
  };
}

/** Spawn a session (optionally running a command inside a fresh shell). */
export function spawnTmuxSession(name: string, cwd: string, command?: string) {
  run(["new-session", "-d", "-s", name, "-c", cwd]);
  if (command) run(["send-keys", "-t", name, "-l", "--", command]);
  if (command) run(["send-keys", "-t", name, "Enter"]);
}

export function killTmuxSession(name: string) {
  run(["kill-session", "-t", name]);
}
