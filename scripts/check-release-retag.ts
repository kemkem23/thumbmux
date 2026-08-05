import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const PACKAGE_MANIFESTS = new Set([
  "package.json",
  "core/package.json",
  "server/package.json",
  "svelte/package.json",
  "app/package.json",
]);
const ALLOWED_RETAG_FILES = new Set([
  ...PACKAGE_MANIFESTS,
  "bun.lock",
  "CONTRACT.md",
]);

function comparableJson(path: string, source: string): unknown {
  const value = JSON.parse(source) as Record<string, unknown>;
  if (PACKAGE_MANIFESTS.has(path)) {
    delete value.version;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      const dependencies = value[field];
      if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
      for (const dependency of Object.keys(dependencies)) {
        if (dependency.startsWith("@thumbmux/")) {
          (dependencies as Record<string, unknown>)[dependency] = "<internal-version>";
        }
      }
    }
    return value;
  }
  if (path === "bun.lock") {
    const workspaces = value.workspaces;
    if (workspaces && typeof workspaces === "object" && !Array.isArray(workspaces)) {
      for (const workspace of Object.values(workspaces)) {
        if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) continue;
        const manifest = workspace as Record<string, unknown>;
        if ("version" in manifest) manifest.version = "<workspace-version>";
        const dependencies = manifest.dependencies;
        if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
        for (const dependency of Object.keys(dependencies)) {
          if (dependency.startsWith("@thumbmux/")) {
            (dependencies as Record<string, unknown>)[dependency] = "<internal-version>";
          }
        }
      }
    }
    return value;
  }
  return value;
}

function contractWithoutReleaseStatus(source: string): string {
  const title = "# thumbmux compatibility contract\n\n";
  const statusStart = title.length;
  const coverage = source.indexOf("\n\nThis contract covers the public exports", statusStart);
  const statusParagraph = source.slice(statusStart, coverage);
  if (
    !source.startsWith(title)
    || !statusParagraph.startsWith("Status:")
    || statusParagraph.includes("\n\n")
    || coverage <= statusStart
  ) {
    throw new Error("CONTRACT.md has no stable coverage paragraph around its release status");
  }
  let normalized = `${source.slice(0, statusStart)}<release-status-intro>${source.slice(coverage)}`;
  const tierDefinitions = normalized.indexOf("\n\n## Tier definitions");
  const gateHeading = normalized.indexOf("### The gate to 1.0");
  const finalParagraph = normalized.lastIndexOf("\n\n", tierDefinitions - 1);
  if (
    gateHeading < 0
    || tierDefinitions < 0
    || finalParagraph <= gateHeading
  ) {
    throw new Error("CONTRACT.md has no stable 1.0 gate conclusion around its release status");
  }
  normalized = `${normalized.slice(0, finalParagraph + 2)}<release-status-conclusion>${normalized.slice(tierDefinitions)}`;
  return normalized;
}

export function assertRetagFileChange(
  path: string,
  before: string,
  after: string,
): void {
  if (!ALLOWED_RETAG_FILES.has(path)) {
    throw new Error(`1.0 must be a no-code-delta retag; unexpected changed file ${path}`);
  }
  if (path === "CONTRACT.md") {
    try {
      if (contractWithoutReleaseStatus(before) === contractWithoutReleaseStatus(after)) return;
    } catch {
      // The error below deliberately keeps malformed and over-broad changes on
      // one fail-closed release diagnostic.
    }
    throw new Error("1.0 retag changed CONTRACT.md beyond release-status paragraphs");
  }
  if (JSON.stringify(comparableJson(path, before)) !== JSON.stringify(comparableJson(path, after))) {
    throw new Error(`1.0 retag changed ${path} beyond version metadata`);
  }
}

function git(args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function previousPreOneTag(): string {
  const configured = process.env.THUMBMUX_RETAG_BASELINE?.trim();
  if (configured) return configured;
  const tags = git(["tag", "--list", "v0.*"]).split(/\s+/)
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .sort((left, right) => {
      const a = left.slice(1).split(".").map(Number);
      const b = right.slice(1).split(".").map(Number);
      return (b[0]! - a[0]!) || (b[1]! - a[1]!) || (b[2]! - a[2]!);
    });
  if (!tags[0]) throw new Error("1.0 retag check found no prior v0.X.Y source tag");
  return tags[0];
}

export function assertReleaseRetag(tag: string): string | null {
  if (tag !== "v1.0.0") return null;
  const baseline = previousPreOneTag();
  const prefix = git(["rev-parse", "--show-prefix"]).trim();
  const changed = git(["diff", "--name-only", "--relative", `${baseline}..HEAD`, "--", "."])
    .split(/\r?\n/).filter(Boolean);
  for (const relative of changed) {
    const repositoryPath = `${prefix}${relative}`;
    const before = git(["show", `${baseline}:${repositoryPath}`]);
    const after = readFileSync(resolve(PACKAGE_ROOT, relative), "utf8");
    assertRetagFileChange(relative, before, after);
  }
  return baseline;
}

if (import.meta.main) {
  try {
    const tag = process.env.GITHUB_REF_NAME?.trim() ?? "";
    const baseline = assertReleaseRetag(tag);
    console.log(baseline
      ? `release retag check passed: ${baseline} -> ${tag} contains version/status changes only`
      : `release retag check: ${tag || "non-tag"} is not v1.0.0; no retag restriction`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
