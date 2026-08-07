/**
 * TM-19 — shipped `.svelte` sources must pass strict svelte-check.
 *
 * Consumers compile the sources from the dist tag under their own
 * `svelte-check --threshold error` gates. Errors that only appear there
 * were silent for us until Hispeed reported them. This test runs the same
 * tool against `svelte/src` so a regression fails CI before release.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const svelteDir = join(packageRoot, "svelte");
const svelteCheckBin = join(packageRoot, "node_modules", ".bin", "svelte-check");

describe("TM-19 svelte-check gate (strict shipped sources)", () => {
  test("svelte-check --threshold error exits 0 on svelte/src", () => {
    expect(existsSync(svelteCheckBin)).toBe(true);
    expect(existsSync(join(svelteDir, "tsconfig.json"))).toBe(true);

    const result = Bun.spawnSync({
      cmd: [
        svelteCheckBin,
        "--tsconfig",
        "./tsconfig.json",
        "--threshold",
        "error",
      ],
      cwd: svelteDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${join(packageRoot, "node_modules", ".bin")}:${process.env.PATH ?? ""}` },
    });

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    const combined = `${stdout}\n${stderr}`;

    if (result.exitCode !== 0) {
      // Surface the raw tool output so a red CI run is self-explaining.
      throw new Error(
        `svelte-check failed (exit ${result.exitCode}).\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }

    // Defensive: tool sometimes prints "found N errors" even on odd exits.
    expect(combined).not.toMatch(/svelte-check found [1-9]\d* errors/);
  }, 120_000);
});
