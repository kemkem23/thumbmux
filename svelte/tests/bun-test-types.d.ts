/**
 * Bun test and runtime type declarations for svelte-check test gate (TM-19).
 *
 * `svelte/tsconfig.tests.json` only widens `include` to `tests/**` — it must
 * not add compilerOptions (the gate asserts that). Tests import `bun:test`
 * and reference `Bun`, so they need ambient types without relaxing the
 * shipped `src` config.
 *
 * `@types/bun` lives on the `server` workspace and is not hoisted to this
 * package root, so TypeScript walking up from `svelte/` never sees it in a
 * standalone checkout. The monorepo root's `@types/bun` hid that locally.
 * Putting `@types/bun` on `svelte` would auto-include Bun globals into
 * shipped `src` via default typeRoots; `bun-types` does not live under
 * `@types/`, so it is pulled in only through this tests-only reference.
 *
 * Resolve by package name, not a path into `node_modules/.bun/<version>/`.
 */
/// <reference types="bun-types" />
