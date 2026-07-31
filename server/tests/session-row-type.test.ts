import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("minimal interface and complete session rows satisfy the public server types", () => {
  const config = resolve(import.meta.dir, "session-row-type.tsconfig.json");
  const result = Bun.spawnSync(
    [process.execPath, "x", "tsc", "--noEmit", "-p", config],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();

  if (result.exitCode !== 0) {
    throw new Error(output || `tsc exited ${result.exitCode}`);
  }
  expect(result.exitCode).toBe(0);
});
