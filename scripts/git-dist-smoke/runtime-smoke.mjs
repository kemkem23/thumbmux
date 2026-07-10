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
  "createUploadHandler",
]) {
  if (typeof server[name] !== "function") throw new Error(`missing server export: ${name}`);
}

console.log(JSON.stringify({ coreExports: Object.keys(core).length, serverExports: Object.keys(server).length }));
