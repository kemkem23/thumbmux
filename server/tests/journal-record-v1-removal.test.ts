import { test } from "bun:test";
import { resolve } from "node:path";

test("retires the server JournalRecordV1 alias while keeping its replacement", () => {
  const config = resolve(import.meta.dir, "journal-record-v1-removal.tsconfig.json");
  const result = Bun.spawnSync(
    [process.execPath, "x", "tsc", "--noEmit", "-p", config],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();

  if (result.exitCode !== 0) {
    throw new Error(output || `tsc exited ${result.exitCode}`);
  }
});
