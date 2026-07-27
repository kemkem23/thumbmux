/**
 * Resolve Svelte's client entry for mount/unmount in bun:test.
 *
 * Bare `import { mount } from "svelte"` resolves to the server stub under Bun's
 * default export conditions. This helper loads `src/index-client.js` directly
 * so mount smoke tests work with plain `bun test ./svelte/tests/*.test.ts`
 * (no `--conditions=browser` required).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const sveltePkgPath = require.resolve("svelte/package.json");
const svelteClientEntry = join(dirname(sveltePkgPath), "src/index-client.js");

const client = await import(svelteClientEntry);

export const mount = client.mount as typeof import("svelte").mount;
export const unmount = client.unmount as typeof import("svelte").unmount;
export const tick = client.tick as typeof import("svelte").tick;
// flushSync forces pending effects to run to completion so self-invalidating
// $effects surface during the test rather than after it returns.
export const flushSync = client.flushSync as typeof import("svelte").flushSync;
