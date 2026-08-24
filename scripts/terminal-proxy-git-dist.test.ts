import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const SERVER_DIST = join(PACKAGE_ROOT, "git-dist", "server");
const SERVER_ENTRY = join(SERVER_DIST, "index.js");
const SERVER_TYPES = join(SERVER_DIST, "index.d.ts");
const PROXY_TYPES = join(SERVER_DIST, "integrations", "terminal-pty-wal-proxy.d.ts");
const PROXY_ASSET = join(SERVER_DIST, "terminal-pty-wal-proxy.py");

describe("published terminal PTY WAL proxy", () => {
  test("git-dist exports the launch helper in JavaScript and declarations", async () => {
    const server = await import(`${pathToFileURL(SERVER_ENTRY).href}?proxy-asset-test`);
    expect(typeof server.createTerminalPtyWalProxyLaunchSpec).toBe("function");

    const launch = server.createTerminalPtyWalProxyLaunchSpec({
      directory: "/tmp/thumbmux-packed-proxy-test",
      identity: {
        session: "proxy-asset-test",
        instanceId: "proxy-asset-instance",
        paneTarget: "=proxy-asset-test:0.0",
      },
      argv: ["/bin/sh", "-lc", "exit 0"],
    }, {});
    expect(launch.args).toEqual(["-u", PROXY_ASSET]);
    expect(existsSync(launch.args[1])).toBe(true);
    expect(statSync(launch.args[1]!).mode & 0o777).toBe(0o755);
    expect(readFileSync(launch.args[1]!, "utf8")).toStartWith("#!/usr/bin/env python3\n");

    expect(readFileSync(SERVER_TYPES, "utf8"))
      .toContain("export * from './integrations/terminal-pty-wal-proxy.js';");
    expect(readFileSync(PROXY_TYPES, "utf8"))
      .toContain("export declare function createTerminalPtyWalProxyLaunchSpec");
  });
});
