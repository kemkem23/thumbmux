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
import { TmuxWsMux, createBunTmuxDriver, spawnTmuxSession } from "@thumbmux/server";
import type { MuxClientMessage } from "@thumbmux/core";
import qrcode from "qrcode-terminal";
import { networkInterfaces } from "node:os";

const HOST_ALL = process.argv.includes("--host");
const PORT = Number(process.env.PORT || 7681);
const TOKEN = crypto.randomUUID().replace(/-/g, "");
const DIST = new URL("./dist/", import.meta.url).pathname;

const driver = createBunTmuxDriver();
const mux = new TmuxWsMux({ driver, log: console.log });

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

let spawnCounter = 0;

Bun.serve<{ ok: true }>({
  hostname: HOST_ALL ? "0.0.0.0" : "127.0.0.1",
  port: PORT,
  async fetch(req, server) {
    if (!authorized(req)) return new Response("thumbmux demo: missing token (scan the QR)", { status: 403 });
    const url = new URL(req.url);

    if (url.pathname === "/ws/tmux") {
      return server.upgrade(req, { data: { ok: true } })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    }

    if (url.pathname === "/api/spawn" && req.method === "POST") {
      try {
        const body = await req.json().catch(() => ({}));
        const existing = new Set(driver.listSessions().map((s: any) => s.name));
        let name = "";
        do { name = `demo-${++spawnCounter}`; } while (existing.has(name));
        spawnTmuxSession(name, process.cwd(), typeof body.command === "string" && body.command ? body.command : undefined);
        return Response.json({ ok: true, name }, { status: 201 });
      } catch (e: any) {
        return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
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
  websocket: {
    message(ws, raw) {
      try {
        const msg = JSON.parse(String(raw)) as MuxClientMessage;
        if (msg.type === "sessions_subscribe" || msg.type === "client_info") {
          if (msg.type === "sessions_subscribe") mux.subscribeSessions(ws as any);
          return;
        }
        mux.handleMessage(msg, ws as any);
      } catch { /* ignore malformed frames */ }
    },
    open(ws) {
      mux.subscribeSessions(ws as any); // hub gets the list immediately
    },
    close(ws) {
      mux.unsubscribeAll(ws as any);
    },
  },
});

const shownHost = HOST_ALL ? lanIp() : "127.0.0.1";
const link = `http://${shownHost}:${PORT}/?t=${TOKEN}`;
console.log("\nthumbmux demo is up.\n");
console.log(`  local:  http://127.0.0.1:${PORT}/?t=${TOKEN}`);
if (HOST_ALL) console.log(`  phone:  ${link}  (same network)`);
else console.log("  (run with --host to expose on your LAN for the phone)");
console.log("\n  the token IS the auth — anyone with this URL can type into your tmux.\n");
qrcode.generate(link, { small: true });
