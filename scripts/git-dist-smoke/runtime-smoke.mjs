import { existsSync, readFileSync, statSync } from "node:fs";
import * as core from "thumbmux/core";
import * as server from "thumbmux/server";

for (const name of [
  "applyMuxDelta",
  "keyboardEventToSequence",
  "mergeCapturedLinesForStableScroll",
  "paneTextForCopy",
]) {
  if (typeof core[name] !== "function") throw new Error(`missing core export: ${name}`);
}
for (const name of [
  "TmuxWsMux",
  "createBunTmuxDriver",
  "createPrefsHandler",
  "createTerminalPtyWalProxyLaunchSpec",
  "createUploadHandler",
]) {
  if (typeof server[name] !== "function") throw new Error(`missing server export: ${name}`);
}

const proxyLaunch = server.createTerminalPtyWalProxyLaunchSpec({
  directory: "/tmp/thumbmux-packed-proxy-smoke",
  identity: {
    session: "packed-proxy-smoke",
    instanceId: "packed-proxy-instance",
    paneTarget: "=packed-proxy-smoke:0.0",
  },
  argv: ["/bin/sh", "-lc", "exit 0"],
}, {});
const proxyAsset = proxyLaunch.args[1];
if (proxyLaunch.args[0] !== "-u" || typeof proxyAsset !== "string" || !existsSync(proxyAsset)) {
  throw new Error(`packed proxy launch spec does not resolve its helper: ${JSON.stringify(proxyLaunch.args)}`);
}
if ((statSync(proxyAsset).mode & 0o555) !== 0o555) {
  throw new Error(`packed proxy helper is not readable/executable: ${proxyAsset}`);
}
if (!readFileSync(proxyAsset, "utf8").startsWith("#!/usr/bin/env python3\n")) {
  throw new Error(`packed proxy helper has an invalid Python shebang: ${proxyAsset}`);
}

console.log(JSON.stringify({ coreExports: Object.keys(core).length, serverExports: Object.keys(server).length }));
