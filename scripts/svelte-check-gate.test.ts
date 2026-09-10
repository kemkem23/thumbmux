/**
 * TM-19 — strict svelte-check over the package's Svelte code.
 *
 * Two configs, two runs, one reason each:
 *
 * - `svelte/tsconfig.json` covers `src/**` — the shipped sources. Consumers
 *   compile these under their own `svelte-check --threshold error` gates, so
 *   errors that only appear there were silent for us until Hispeed reported
 *   them.
 * - `svelte/tsconfig.tests.json` covers `src/** + tests/**` (widened
 *   2026-09-10, SVELTECHECK-TESTS-20260910). The test folder was outside every
 *   compiler this package runs, so nothing ever type-checked it: a hand-copied
 *   `PromptsPanelProps` had gone stale by two props, a listener map was
 *   declared as a map of functions returning `void[]`, and a delivery callback
 *   was declared wider than the mux's own — all invisible until the gate was
 *   pointed at them.
 *
 * Both runs use the same compiler options; the tests config only widens the
 * file set. `--threshold error` matches what consumers run, so warnings do not
 * fail either run.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const svelteDir = join(packageRoot, "svelte");
const svelteCheckBin = join(packageRoot, "node_modules", ".bin", "svelte-check");

function runSvelteCheck(tsconfig: string): { exitCode: number | null; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [svelteCheckBin, "--tsconfig", tsconfig, "--threshold", "error"],
    cwd: svelteDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${join(packageRoot, "node_modules", ".bin")}:${process.env.PATH ?? ""}` },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function expectClean(tsconfig: string): void {
  const { exitCode, stdout, stderr } = runSvelteCheck(tsconfig);

  if (exitCode !== 0) {
    // Surface the raw tool output so a red CI run is self-explaining.
    throw new Error(
      `svelte-check ${tsconfig} failed (exit ${exitCode}).\n` +
        `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }

  // Defensive: tool sometimes prints "found N errors" even on odd exits.
  expect(`${stdout}\n${stderr}`).not.toMatch(/svelte-check found [1-9]\d* errors/);
}

describe("TM-19 svelte-check gate (strict shipped sources)", () => {
  test("svelte-check --threshold error exits 0 on svelte/src", () => {
    expect(existsSync(svelteCheckBin)).toBe(true);
    expect(existsSync(join(svelteDir, "tsconfig.json"))).toBe(true);

    expectClean("./tsconfig.json");
  }, 120_000);

  test("svelte-check --threshold error exits 0 on svelte/tests too", () => {
    expect(existsSync(join(svelteDir, "tsconfig.tests.json"))).toBe(true);

    expectClean("./tsconfig.tests.json");
  }, 120_000);

  test("the tests config really reaches tests/, and adds no compiler slack", async () => {
    // Two ways this gate could go blind: the config stops matching test files
    // (a rename, a moved folder), or someone relaxes an option to make a red
    // run green. Assert against both, because either failure is silent.
    // tsconfig files are JSONC and this one carries the "why"; drop the
    // whole-line comments so JSON.parse can read it.
    const raw = await Bun.file(join(svelteDir, "tsconfig.tests.json")).text();
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
    expect(config.extends).toBe("./tsconfig.json");
    expect(config.include).toEqual(["src/**/*", "tests/**/*"]);
    expect(config.compilerOptions).toBeUndefined();

    // `--output machine` ends with a COMPLETED line carrying the file count.
    // The src-only run covers far fewer files; if the two ever match, the
    // tests config is no longer picking anything up.
    const filesChecked = (tsconfig: string): number => {
      const result = Bun.spawnSync({
        cmd: [svelteCheckBin, "--tsconfig", tsconfig, "--threshold", "error", "--output", "machine"],
        cwd: svelteDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: `${join(packageRoot, "node_modules", ".bin")}:${process.env.PATH ?? ""}` },
      });
      const completed = result.stdout.toString().match(/COMPLETED (\d+) FILES/);
      if (!completed) throw new Error(`no COMPLETED line from svelte-check ${tsconfig}`);
      return Number(completed[1]);
    };

    expect(filesChecked("./tsconfig.tests.json")).toBeGreaterThan(filesChecked("./tsconfig.json"));
  }, 180_000);
});
