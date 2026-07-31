import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("the guarded kill and preferences security snippet type-checks against source exports", () => {
  const packageRoot = resolve(import.meta.dir, "../..");
  const document = readFileSync(join(packageRoot, "docs/security.md"), "utf8");
  const match = /<!-- B2-GUARDED-HTTP-SNIPPET:START -->\s*```ts\n([\s\S]*?)\n```\s*<!-- B2-GUARDED-HTTP-SNIPPET:END -->/.exec(document);
  expect(match).not.toBeNull();

  const directory = mkdtempSync(join(tmpdir(), "thumbmux-b2-security-snippet-"));
  try {
    writeFileSync(join(directory, "snippet.ts"), `${match![1]}\n`);
    writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        lib: ["ESNext", "DOM"],
        target: "ESNext",
        module: "Preserve",
        moduleResolution: "bundler",
        moduleDetection: "force",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: ["bun"],
        typeRoots: [resolve(packageRoot, "../../node_modules/@types")],
        baseUrl: packageRoot,
        paths: {
          "thumbmux/server": ["server/src/index.ts"],
          "@thumbmux/core": ["core/src/index.ts"],
          "@thumbmux/core/*": ["core/src/*"],
        },
      },
      include: ["./snippet.ts"],
    }, null, 2));

    const result = Bun.spawnSync(
      [process.execPath, "x", "tsc", "--noEmit", "-p", join(directory, "tsconfig.json")],
      { cwd: packageRoot, stdout: "pipe", stderr: "pipe" },
    );
    const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
    expect(output).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
