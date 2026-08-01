import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Must stay inside the package. Reaching for a parent directory's node_modules
// resolves against whatever repo happens to be hosting the sources — it passed
// for a year against the private monorepo's root and failed the moment the
// public checkout, where the package IS the root, ran it.
function bunTypeRoot(packageRoot: string): string {
  const candidates = [
    join(packageRoot, "node_modules/@types"),
    join(packageRoot, "server/node_modules/@types"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "bun"))) return candidate;
  }
  throw new Error(`@types/bun not found under the package; looked in ${candidates.join(", ")}`);
}

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
        typeRoots: [bunTypeRoot(packageRoot)],
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
