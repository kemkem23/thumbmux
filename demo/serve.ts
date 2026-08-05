/**
 * thumbmux demo server — one Bun process:
 *   • serves the built UI (dist/)
 *   • runs TmuxWsMux on /ws/tmux against your local tmux
 *   • POST /api/spawn creates sessions for the launcher
 *
 * Security: binds 127.0.0.1 by default. `--host` binds 0.0.0.0 for your
 * phone — every request then requires the random token baked into the QR
 * URL (cookie'd on first visit). Anyone with the URL can type into your
 * tmux; treat it like an SSH key.
 */
import {
  FileHistoryArchive,
  createAppRoutes,
  createBunTmuxDriver,
  SpawnHandlerError,
} from "@thumbmux/server";
import qrcode from "qrcode-terminal";
import { networkInterfaces } from "node:os";
import {
  createDemoSessionPolicy,
  validateDemoSpawnCwd,
} from "./policy";
import { demoDistPath } from "./server-policy";

const HOST_ALL = process.argv.includes("--host");
const PORT = Number(process.env.PORT || 7681);
const TOKEN = crypto.randomUUID().replace(/-/g, "");
const RUN_ID = crypto.randomUUID().replace(/-/g, "");
const DIST = demoDistPath(import.meta.url);

const driver = createBunTmuxDriver();
const demoSessions = createDemoSessionPolicy(RUN_ID);
// The default archive is a private, per-run temp root, so a recycled session
// name cannot inherit another demo process's scrollback. Setting this variable
// is the explicit opt-in to persistence across runs.
const configuredHistoryRoot = process.env.THUMBMUX_HISTORY_ROOT?.trim();
const archive = new FileHistoryArchive(configuredHistoryRoot ? { root: configuredHistoryRoot } : {});

function lanIp(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "127.0.0.1";
}

function authorized(req: Request): boolean {
  const url = new URL(req.url);
  if (url.searchParams.get("t") === TOKEN) return true;
  const cookie = req.headers.get("cookie") ?? "";
  return cookie.includes(`tmux_demo_t=${TOKEN}`);
}

const routes = createAppRoutes({
  driver,
  archive,
  projectSessionList: demoSessions.project,
  spawn: {
    // Keep the demo rooted where its server process was started. In particular,
    // do not let an HTTP payload select an arbitrary server-side directory.
    cwd: () => process.cwd(),
    validateCwd: validateDemoSpawnCwd,
    generateName: demoSessions.allocate,
    prepareWorktree: ({ name, cwd }) => {
      // Worktree presets isolate the session in a fresh checkout. This policy
      // is demo-specific; the packaged spawn handler only invokes the hooks.
      const top = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
      if (top.exitCode !== 0) {
        throw new SpawnHandlerError(
          400,
          "worktree preset needs the demo to run inside a git repository",
        );
      }
      const root = top.stdout.toString().trim();
      const worktreeCwd = `${root}-wt-${name}`;
      const add = Bun.spawnSync(["git", "-C", root, "worktree", "add", "--detach", worktreeCwd]);
      if (add.exitCode !== 0) {
        throw new SpawnHandlerError(
          500,
          `git worktree add failed: ${add.stderr.toString().trim()}`,
        );
      }
      return worktreeCwd;
    },
    cleanupWorktree: ({ cwd, worktreeCwd }) => {
      const remove = Bun.spawnSync([
        "git", "-C", cwd, "worktree", "remove", "--force", worktreeCwd,
      ]);
      if (remove.exitCode !== 0) {
        throw new SpawnHandlerError(
          500,
          `git worktree rollback failed: ${remove.stderr.toString().trim()}`,
        );
      }
    },
  },
  upload: { dir: "uploads" },
  prefs: false,
  kill: { enabled: false },
  mux: { log: console.log },
});

Bun.serve({
  hostname: HOST_ALL ? "0.0.0.0" : "127.0.0.1",
  port: PORT,
  async fetch(req, server) {
    if (!authorized(req)) return new Response("thumbmux demo: missing token (scan the QR)", { status: 403 });
    const handled = await routes.fetch(req, server);
    if (handled) return handled;
    const url = new URL(req.url);

    // AppAdapters.prompts needs a pane snapshot; createAppRoutes deliberately
    // owns no prompt-extraction policy, so the demo supplies this one route.
    if (url.pathname === "/api/prompts" && req.method === "GET") {
      const session = url.searchParams.get("session")?.trim();
      if (!session) return new Response("missing session", { status: 400 });
      try {
        return new Response(await driver.capturePane(session, { startLine: -4_000 }));
      } catch {
        return new Response("session not found", { status: 404 });
      }
    }

    // static: dist/ with an index fallback + token cookie
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(DIST + path.slice(1));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    const res = new Response(file);
    res.headers.set("Set-Cookie", `tmux_demo_t=${TOKEN}; Path=/; SameSite=Strict`);
    return res;
  },
  websocket: routes.websocket,
});

const shownHost = HOST_ALL ? lanIp() : "127.0.0.1";
const link = `http://${shownHost}:${PORT}/?t=${TOKEN}`;
console.log("\nthumbmux demo is up.\n");
console.log(`  local:  http://127.0.0.1:${PORT}/?t=${TOKEN}`);
if (HOST_ALL) console.log(`  phone:  ${link}  (same network)`);
else console.log("  (run with --host to expose on your LAN for the phone)");
console.log("\n  the token IS the auth — anyone with this URL can type into your tmux.\n");
qrcode.generate(link, { small: true });
