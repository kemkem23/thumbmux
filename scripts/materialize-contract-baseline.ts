import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const REQUIRED_ASSETS = [
  "package.json",
  "contract/manifest/core.json",
  "contract/manifest/server.json",
  "contract/manifest/svelte.json",
  "contract/manifest/app.json",
  "git-dist/core/index.d.ts",
  "git-dist/server/index.d.ts",
  "git-dist/svelte/index.d.ts",
  "git-dist/app/index.d.ts",
] as const;

type Triple = readonly [number, number, number];

function semver(version: string): Triple {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`contract baseline requires X.Y.Z, received ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(left: Triple, right: Triple): number {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

export function selectContractBaselineTag(
  refs: string,
  currentVersion: string,
): string {
  const current = semver(currentVersion);
  const candidates = refs.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/(?:^|\s)refs\/tags\/(v(\d+\.\d+\.\d+)-dist)$/);
    if (!match) return [];
    const version = semver(match[2]!);
    return compare(version, current) <= 0 ? [{ tag: match[1]!, version }] : [];
  }).sort((left, right) => compare(right.version, left.version));
  if (!candidates[0]) {
    throw new Error(`no immutable vX.Y.Z-dist baseline at or before ${currentVersion}`);
  }
  return candidates[0].tag;
}

function command(
  executable: string,
  args: readonly string[],
  options: { cwd?: string } = {},
): string {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout}`.trim();
    throw new Error(`${executable} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function resolveRemote(packageRoot: string, configured?: string): string {
  const repoRoot = command("git", ["rev-parse", "--show-toplevel"], { cwd: packageRoot }).trim();
  const remotes = new Set(command("git", ["remote"], { cwd: repoRoot }).split(/\s+/).filter(Boolean));
  const requested = configured?.trim()
    || (remotes.has("thumbmux-public") ? "thumbmux-public" : "origin");
  return remotes.has(requested)
    ? command("git", ["remote", "get-url", requested], { cwd: repoRoot }).trim()
    : requested;
}

export type MaterializeContractBaselineOptions = {
  packageRoot?: string;
  remote?: string;
  /** Already-resolved URL/path, usable from a git archive with no .git dir. */
  remoteUrl?: string;
};

export function materializeContractBaseline(
  outputRoot: string,
  options: MaterializeContractBaselineOptions = {},
): string {
  const packageRoot = resolve(options.packageRoot ?? PACKAGE_ROOT);
  const output = resolve(outputRoot);
  if (existsSync(output) && readdirSync(output).length > 0) {
    throw new Error(`contract baseline output must be empty: ${output}`);
  }
  mkdirSync(output, { recursive: true });

  const currentPackage = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof currentPackage.version !== "string") {
    throw new Error("current package.json version must be a string");
  }
  semver(currentPackage.version);

  const remoteUrl = options.remoteUrl?.trim()
    || process.env.THUMBMUX_CONTRACT_REMOTE_URL?.trim();
  const remote = remoteUrl
    || resolveRemote(packageRoot, options.remote ?? process.env.THUMBMUX_CONTRACT_REMOTE);
  const refs = command("git", ["ls-remote", "--tags", "--refs", remote, "v*-dist"]);
  const tag = selectContractBaselineTag(refs, currentPackage.version);
  const expectedObject = refs.split(/\r?\n/).find((line) =>
    line.endsWith(`\trefs/tags/${tag}`))?.split(/\s+/, 1)[0];
  if (!expectedObject || !/^[a-f0-9]{40,64}$/.test(expectedObject)) {
    throw new Error(`could not pin immutable object ID for ${tag}`);
  }
  const expectedVersion = tag.slice(1, -"-dist".length);

  const fetchRoot = mkdtempSync(join(tmpdir(), "thumbmux-contract-baseline-fetch-"));
  try {
    const bare = join(fetchRoot, "baseline.git");
    const archive = join(fetchRoot, "baseline.tar");
    command("git", ["init", "--bare", bare]);
    command("git", [
      `--git-dir=${bare}`,
      "fetch",
      "--depth=1",
      remote,
      `refs/tags/${tag}:refs/tags/${tag}`,
    ]);
    const fetchedObject = command("git", [
      `--git-dir=${bare}`,
      "rev-parse",
      `refs/tags/${tag}`,
    ]).trim();
    if (fetchedObject !== expectedObject) {
      throw new Error(`${tag} moved while its immutable baseline was being fetched`);
    }
    command("git", [
      `--git-dir=${bare}`,
      "archive",
      "--format=tar",
      `--output=${archive}`,
      tag,
      "package.json",
      "contract/manifest",
      "git-dist",
    ]);
    command("tar", ["-xf", archive, "-C", output]);
  } finally {
    rmSync(fetchRoot, { recursive: true, force: true });
  }

  const missing = REQUIRED_ASSETS.filter((path) => !existsSync(join(output, path)));
  if (missing.length > 0) {
    throw new Error(`${tag} is not a usable contract baseline; missing ${missing.join(", ")}`);
  }
  const baselinePackage = JSON.parse(
    readFileSync(join(output, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (baselinePackage.version !== expectedVersion) {
    throw new Error(
      `${tag} package.json version is ${String(baselinePackage.version)}, expected ${expectedVersion}`,
    );
  }
  return tag;
}

if (import.meta.main) {
  try {
    const output = process.argv[2];
    if (!output) throw new Error("usage: bun scripts/materialize-contract-baseline.ts <empty-output-dir>");
    const tag = materializeContractBaseline(output);
    console.log(`contract baseline: materialized ${tag} at ${resolve(output)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
