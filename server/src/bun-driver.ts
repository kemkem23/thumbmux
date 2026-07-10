/**
 * Reference TmuxDriver for Bun — talks to a local tmux over its CLI. This is
 * what the demo uses; production hosts usually bring richer drivers (shared
 * activity caches, worktree spawning, memory-scoped launches…) but this one
 * is complete and honest: every TmuxWsMux feature works against it.
 */
import type { RawCursorState, TmuxDriver } from "./ws-mux";

const LARGE_INPUT_THRESHOLD_BYTES = 8 * 1024;

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

function sendLargeInput(session: string, bytes: Uint8Array) {
  const bufferName = `thumbmux-input-${crypto.randomUUID()}`;
  try {
    runWithStdin(["load-buffer", "-b", bufferName, "-"], bytes);
    run(["paste-buffer", "-d", "-b", bufferName, "-t", session]);
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
      const bytes = new TextEncoder().encode(data);
      if (bytes.byteLength <= LARGE_INPUT_THRESHOLD_BYTES) {
        run(["send-keys", "-t", session, "-l", "--", data]);
        return;
      }
      sendLargeInput(session, bytes);
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
      const args = ["display-message", "-t", session, "-p",
        "#{cursor_x}|#{cursor_y}|#{pane_height}|#{cursor_flag}|#{pane_in_mode}",
        ";", "capture-pane", "-t", session, "-p", "-e"];
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
export function spawnTmuxSession(name: string, cwd: string, command?: string) {
  run(["new-session", "-d", "-s", name, "-c", cwd]);
  if (command) run(["send-keys", "-t", name, "-l", "--", command]);
  if (command) run(["send-keys", "-t", name, "Enter"]);
}

export function killTmuxSession(name: string) {
  run(["kill-session", "-t", name]);
}
