import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertReleaseVersion } from "./check-release-version";
import { assertRetagFileChange } from "./check-release-retag";
import {
  materializeContractBaseline,
  selectContractBaselineTag,
} from "./materialize-contract-baseline";
import {
  prepareReleasePackage,
  RELEASE_PACKAGE_EXPORTS,
  RELEASE_PACKAGE_FILES,
} from "./prepare-release-package";

const packageRoot = resolve(import.meta.dir, "..");
const releaseWorkflow = readFileSync(
  resolve(packageRoot, ".github/workflows/release.yml"),
  "utf8",
);
const ciWorkflow = readFileSync(
  resolve(packageRoot, ".github/workflows/ci.yml"),
  "utf8",
);
const parity = readFileSync(resolve(import.meta.dir, "ci-parity.sh"), "utf8");
const smoke = readFileSync(resolve(import.meta.dir, "smoke-git-dist.sh"), "utf8");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release rail policy", () => {
  test("immutable baseline selection uses the newest eligible remote dist tag", () => {
    const refs = [
      "aaa refs/tags/v0.7.1-dist",
      "bbb refs/tags/v0.9.1-dist",
      "ccc refs/tags/v0.10.0-dist",
      "ddd refs/tags/v0.9.2",
    ].join("\n");
    expect(selectContractBaselineTag(refs, "0.9.2")).toBe("v0.9.1-dist");
  });

  test("materializer fetches an eligible dist absent from local tag state", () => {
    const root = mkdtempSync(join(tmpdir(), "thumbmux-contract-remote-"));
    const remote = join(root, "public");
    const current = join(root, "current");
    const output = join(root, "baseline");
    roots.push(root);
    mkdirSync(remote, { recursive: true });
    mkdirSync(current, { recursive: true });
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync({
        cmd: ["git", ...args],
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.toString() || result.stdout.toString());
      }
    };
    git(remote, "init", "-q");
    git(remote, "config", "user.name", "contract-test");
    git(remote, "config", "user.email", "contract-test@example.invalid");
    mkdirSync(join(remote, "contract/manifest"), { recursive: true });
    for (const subpath of ["core", "server", "svelte", "app"]) {
      mkdirSync(join(remote, `git-dist/${subpath}`), { recursive: true });
      writeFileSync(join(remote, `contract/manifest/${subpath}.json`), "[]\n");
      writeFileSync(join(remote, `git-dist/${subpath}/index.d.ts`), "export {};\n");
    }
    writeFileSync(join(remote, "package.json"), `${JSON.stringify({ version: "0.9.1" })}\n`);
    git(remote, "add", ".");
    git(remote, "commit", "-qm", "baseline");
    git(remote, "tag", "v0.7.1-dist");
    git(remote, "tag", "v0.9.1-dist");
    git(remote, "tag", "v0.10.0-dist");

    // This untagged current checkout has no local tag objects. The separate
    // remote still has the required v0.9.1 immutable artifact.
    writeFileSync(join(current, "package.json"), `${JSON.stringify({ version: "0.9.2" })}\n`);
    expect(materializeContractBaseline(output, {
      packageRoot: current,
      remoteUrl: remote,
    })).toBe("v0.9.1-dist");
    expect(JSON.parse(readFileSync(join(output, "package.json"), "utf8")).version)
      .toBe("0.9.1");
  });

  test("version validator rejects a tag/manifests split and accepts aligned ranges", () => {
    const root = mkdtempSync(join(tmpdir(), "thumbmux-release-version-"));
    try {
      for (const path of ["core", "server", "svelte", "app"]) {
        mkdirSync(join(root, path), { recursive: true });
      }
      const writeManifest = (
        path: string,
        version: string,
        dependencies: Record<string, string> = {},
      ) => writeFileSync(join(root, path, "package.json"), JSON.stringify({
        name: path || "thumbmux",
        version,
        dependencies,
      }));
      writeManifest("", "0.9.1");
      writeManifest("core", "0.9.1");
      writeManifest("server", "0.9.1", { "@thumbmux/core": "^0.9.1" });
      writeManifest("svelte", "0.9.1", { "@thumbmux/core": "^0.9.1" });
      writeManifest("app", "0.9.1", {
        "@thumbmux/core": "^0.9.1",
        "@thumbmux/svelte": "^0.9.1",
      });

      expect(() => assertReleaseVersion("v0.9.2", root)).toThrow(
        /package\.json: version 0\.9\.1 != 0\.9\.2/,
      );
      for (const path of ["", "core", "server", "svelte", "app"]) {
        const dependencies: Record<string, string> = path === "server" || path === "svelte"
          ? { "@thumbmux/core": "^0.9.2" }
          : path === "app"
            ? { "@thumbmux/core": "^0.9.2", "@thumbmux/svelte": "^0.9.2" }
            : {};
        writeManifest(path, "0.9.2", dependencies);
      }
      expect(assertReleaseVersion("v0.9.2", root)).toBe("0.9.2");

      writeManifest("app", "0.9.1", {
        "@thumbmux/core": "^0.9.2",
        "@thumbmux/svelte": "^0.9.2",
      });
      expect(() => assertReleaseVersion("v0.9.2", root)).toThrow(
        /app\/package\.json: version 0\.9\.1 != 0\.9\.2/,
      );
      writeManifest("app", "0.9.2", {
        "@thumbmux/core": "workspace:*",
        "@thumbmux/svelte": "^0.9.2",
      });
      expect(() => assertReleaseVersion("v0.9.2", root)).toThrow(
        /app\/package\.json: @thumbmux\/core workspace:\* != \^0\.9\.2/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("release validates its tag against every shipped package manifest first", () => {
    const check = "bun scripts/check-release-version.ts";
    expect(releaseWorkflow).toContain(check);
    expect(releaseWorkflow.indexOf(check)).toBeLessThan(
      releaseWorkflow.indexOf("bun run build:git-dist"),
    );
    expect(releaseWorkflow).toContain("bun scripts/check-release-retag.ts");
  });

  test("1.0 retag rail permits version metadata but rejects code and script drift", () => {
    expect(() => assertRetagFileChange(
      "core/package.json",
      JSON.stringify({ version: "0.9.2", scripts: { test: "bun test" } }),
      JSON.stringify({ version: "1.0.0", scripts: { test: "bun test" } }),
    )).not.toThrow();
    expect(() => assertRetagFileChange(
      "core/package.json",
      JSON.stringify({ version: "0.9.2", scripts: { test: "bun test" } }),
      JSON.stringify({ version: "1.0.0", scripts: { test: "echo skipped" } }),
    )).toThrow(/beyond version metadata/);
    expect(() => assertRetagFileChange(
      "core/src/protocol.ts",
      "export type Frame = Old;",
      "export type Frame = New;",
    )).toThrow(/unexpected changed file/);

    const contractBefore = readFileSync(resolve(packageRoot, "CONTRACT.md"), "utf8");
    const contractAfter = contractBefore
      .replace(
        "the gates needed to earn a 1.0 release; it does not declare those gates passed.",
        "the gates needed to earn a 1.0 release; those gates are now declared passed.",
      )
      .replace(
        "Until all four evidence records exist, project documentation and releases must\nnot claim that thumbmux is \"SemVer 1.0 compliant\".",
        "All four evidence records now exist; project documentation and releases may\nclaim that thumbmux is \"SemVer 1.0 compliant\".",
      );
    expect(contractAfter).not.toBe(contractBefore);
    expect(() => assertRetagFileChange("CONTRACT.md", contractBefore, contractAfter))
      .not.toThrow();
    expect(() => assertRetagFileChange(
      "CONTRACT.md",
      contractBefore,
      contractBefore.replace(
        "\n\nThis contract covers the public exports",
        "\n\nInjected policy paragraph.\n\nThis contract covers the public exports",
      ),
    )).toThrow(/beyond release-status paragraphs/);
    expect(() => assertRetagFileChange(
      "CONTRACT.md",
      contractBefore,
      contractBefore.replace(
        "The policy below refers to these enforcement layers.",
        "The compatibility policy no longer uses enforcement layers.",
      ),
    )).toThrow(/beyond release-status paragraphs/);
    expect(() => assertRetagFileChange(
      "CONTRACT.md",
      contractBefore,
      "malicious wholesale rewrite",
    )).toThrow(/beyond release-status paragraphs/);
  });

  test("CI and release reject focused Playwright tests before the canonical run", () => {
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      expect(workflow).toContain("--forbid-only");
      const preflight = workflow.slice(
        workflow.lastIndexOf("- name: reject focused Playwright tests", workflow.indexOf("--forbid-only")),
        workflow.indexOf("- name: canonical container e2e"),
      );
      expect(preflight).toContain("DEMO_URL:");
      expect(workflow.indexOf("--forbid-only")).toBeLessThan(
        workflow.indexOf("./e2e/run-container.sh"),
      );
    }
  });

  test("ci parity cannot call an E2E skip a pass and includes publish readiness", () => {
    const skipBranch = parity.slice(
      parity.indexOf('THUMBMUX_SKIP_E2E:-0'),
      parity.indexOf("fi", parity.indexOf('THUMBMUX_SKIP_E2E:-0')) + 2,
    );
    expect(skipBranch).toContain("exit 1");
    expect(parity).toContain("demo builds");
    for (const packageName of ["core", "server", "svelte", "app"]) {
      expect(parity).toContain(`cd ${packageName}`);
      expect(parity).toContain("bun pm pack");
    }
    expect(parity).toContain("--forbid-only");
    expect(parity).toContain('DEMO_URL="${DEMO_URL:-http://127.0.0.1:1}"');
  });

  test("CI, release, and local parity materialize a verified remote baseline", () => {
    for (const rail of [ciWorkflow, releaseWorkflow, parity]) {
      expect(rail).toContain("materialize-contract-baseline.ts");
      expect(rail).toContain("THUMBMUX_CONTRACT_REQUIRE_BASELINE=1");
      expect(rail).not.toContain("tag --list 'v[0-9]*-dist'");
    }
    expect(parity).toContain("THUMBMUX_CONTRACT_REMOTE_URL");
    expect(parity.indexOf("git -C \"$repo_root\" archive \"$archive_ref\""))
      .toBeLessThan(parity.lastIndexOf("materialize-contract-baseline.ts"));
  });

  test("root smoke stages and verifies every advertised contract asset", () => {
    expect(smoke).toContain('cp "$PACKAGE_ROOT/CONTRACT.md" "$WORK/package/"');
    expect(smoke).toContain('cp -R "$PACKAGE_ROOT/contract/manifest" "$WORK/package/contract/"');
    expect(smoke).toContain("package/CONTRACT.md");
    for (const subpath of ["core", "server", "svelte", "app"]) {
      expect(smoke).toContain(`package/contract/manifest/${subpath}.json`);
    }
  });

  test("release and smoke derive the packed root manifest from one helper", () => {
    expect(releaseWorkflow).toContain("prepare-release-package.ts");
    expect(smoke).toContain("prepare-release-package.ts");

    const root = mkdtempSync(join(tmpdir(), "thumbmux-release-package-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "thumbmux",
      version: "0.9.2",
      scripts: { postinstall: "unexpected" },
      files: ["git-dist"],
    }));
    prepareReleasePackage(root);
    const prepared = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(prepared.scripts).toBeUndefined();
    expect(prepared.files).toEqual(RELEASE_PACKAGE_FILES);
    expect(prepared.exports).toEqual(RELEASE_PACKAGE_EXPORTS);
  });
});
