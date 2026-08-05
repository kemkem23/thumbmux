import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const MANIFESTS = ["package.json", "core/package.json", "server/package.json", "svelte/package.json", "app/package.json"] as const;

type PackageManifest = {
  name?: unknown;
  version?: unknown;
  dependencies?: Record<string, unknown>;
};

export function assertReleaseVersion(
  tag: string,
  packageRoot = PACKAGE_ROOT,
): string {
  const match = tag.match(/^v(\d+\.\d+\.\d+)$/);
  if (!match) throw new Error(`release tag must be vX.Y.Z, received ${JSON.stringify(tag)}`);
  const version = match[1]!;
  const errors: string[] = [];
  const manifests = new Map<string, PackageManifest>();

  for (const relativePath of MANIFESTS) {
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, relativePath), "utf8"),
    ) as PackageManifest;
    manifests.set(relativePath, manifest);
    if (manifest.version !== version) {
      errors.push(`${relativePath}: version ${String(manifest.version)} != ${version}`);
    }
  }

  for (const [relativePath, manifest] of manifests) {
    for (const [dependency, declared] of Object.entries(manifest.dependencies ?? {})) {
      if (!dependency.startsWith("@thumbmux/")) continue;
      if (declared !== `^${version}`) {
        errors.push(`${relativePath}: ${dependency} ${String(declared)} != ^${version}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`release version mismatch for ${tag}:\n${errors.map((line) => `- ${line}`).join("\n")}`);
  }
  return version;
}

if (import.meta.main) {
  try {
    const tag = process.env.GITHUB_REF_NAME?.trim() ?? "";
    const version = assertReleaseVersion(tag);
    console.log(`release version check passed: ${version} across ${MANIFESTS.length} manifests`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
