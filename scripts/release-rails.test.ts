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
const e2eRunner = readFileSync(resolve(packageRoot, "e2e/run-container.sh"), "utf8");
const e2eConfig = readFileSync(resolve(packageRoot, "e2e/playwright.config.ts"), "utf8");
const e2eHelpers = readFileSync(resolve(packageRoot, "e2e/helpers.ts"), "utf8");
const gitIgnore = readFileSync(resolve(packageRoot, ".gitignore"), "utf8");
const node18ReplayLockSmoke = readFileSync(
  resolve(import.meta.dir, "git-dist-smoke/node18-replay-lock-smoke.mjs"),
  "utf8",
);
/** Single source of truth for the shared CI/release verification gate. */
const VERIFY_GATE_REL = ".github/actions/verify-gate/action.yml";
const VERIFY_GATE_USES = "./.github/actions/verify-gate";
const roots: string[] = [];

function readVerifyGate(): string {
  return readFileSync(resolve(packageRoot, VERIFY_GATE_REL), "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release rail policy", () => {
  test("Svelte package scratch output cannot dirty Docker source admission", () => {
    expect(gitIgnore).toContain("svelte/.svelte-kit/");
    expect(gitIgnore).toContain("app/.svelte-kit/");
  });

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

  test("CI and release-dist share one verification gate (cannot green independently)", () => {
    // Historical failure mode (2026-08-06): ci.yml and release.yml carried
    // hand-copied step lists that drifted. release-dist went green and pushed
    // v0.10.0-dist / v0.11.0-dist while ci was red on the same commit. Dist
    // tags are immutable, so the only recovery was burning two version numbers
    // (→ 0.10.1 / 0.11.1). Human discipline ("wait for both green") failed
    // twice in one day; this test makes the shared definition mechanical.
    //
    // Invariant: both workflows must `uses:` the same local composite action,
    // and that action (not the workflow files) owns every verification step
    // that historically diverged. Release-only steps (version/retag check,
    // commit+tag+push) stay outside the gate on purpose.
    expect(ciWorkflow).toContain(`uses: ${VERIFY_GATE_USES}`);
    expect(releaseWorkflow).toContain(`uses: ${VERIFY_GATE_USES}`);

    const gate = readVerifyGate();

    // Markers of steps that were present in one workflow and missing (or
    // ordered differently) in the other before the unify. If any of these
    // leave the gate, the two rails can green independently again.
    const requiredGateMarkers = [
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
      "node-version: 22.23.2",
      "check-latest: false",
      "oven-sh/setup-bun@v2",
      "bun-version:",
      "bun install --frozen-lockfile",
      '"$thumbmux_node_bin" "$playwright_cli" install --with-deps chromium',
      "@playwright+test@1.61.1/node_modules/@playwright/test/cli.js",
      "bun run build:git-dist",
      // Combined unit suite — the process release always ran; must not split
      // into different globs per workflow.
      "bun test --timeout 120000 ./server/tests/*.test.ts ./core/tests/*.test.ts ./core/src/*.test.ts ./svelte/tests/*.test.ts ./app/tests/*.test.ts ./demo/*.test.ts ./scripts/*.test.ts",
      "cd demo && bun run build",
      "--forbid-only",
      "./e2e/run-container.sh",
      // packages build & pack was CI-only before unify — release could ship
      // without proving pack readiness.
      "bun pm pack",
      "smoke:git-dist",
      "materialize-contract-baseline.ts",
      "THUMBMUX_CONTRACT_BASELINE_ROOT=",
      "bun run contract",
      "./scripts/contract-fixtures.sh",
      "source integrity after verification",
      "git ls-files --others --exclude-standard",
    ];
    for (const marker of requiredGateMarkers) {
      expect(gate).toContain(marker);
    }

    // Docker admission requires the primary checkout to be the clean exact
    // public commit. build:git-dist and later suites intentionally create
    // ignored artifacts, so the canonical E2E lane must run before the first
    // source-tree build instead of weakening the runtime guard for dirty state.
    const nodeSetupStep = gate.indexOf("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
    const bunSetupStep = gate.indexOf("oven-sh/setup-bun@v2");
    const frozenInstallStep = gate.indexOf("bun install --frozen-lockfile");
    const playwrightInstallStep = gate.indexOf("- name: install Playwright Chromium");
    const e2eStep = gate.indexOf("- name: canonical container e2e");
    const artifactBuildStep = gate.indexOf("- name: build git-dist for the artifact tests");
    expect(nodeSetupStep).toBeGreaterThan(-1);
    expect(bunSetupStep).toBeGreaterThan(nodeSetupStep);
    expect(frozenInstallStep).toBeGreaterThan(bunSetupStep);
    expect(playwrightInstallStep).toBeGreaterThan(frozenInstallStep);
    expect(e2eStep).toBeGreaterThan(playwrightInstallStep);
    expect(e2eStep).toBeGreaterThan(-1);
    expect(artifactBuildStep).toBeGreaterThan(e2eStep);

    const nodeSetupBlock = gate.slice(nodeSetupStep, bunSetupStep);
    expect(nodeSetupBlock).toContain("node-version: 22.23.2");
    expect(nodeSetupBlock).toContain("check-latest: false");
    expect(nodeSetupBlock).not.toContain("cache:");
    expect(gate).not.toContain("actions/setup-node@v");

    // Neither workflow re-inlines the combined unit suite (would re-open
    // copy-paste drift). The only bun test invocation for the full suite lives
    // in the gate.
    const inlineCombinedSuite =
      /bun test --timeout 120000 \.\/server\/tests\/\*\.test\.ts/;
    expect(ciWorkflow).not.toMatch(inlineCombinedSuite);
    expect(releaseWorkflow).not.toMatch(inlineCombinedSuite);

    // Bun pin is single-sourced in the gate; parity must read it from there
    // (not from a workflow that no longer owns the pin).
    expect(parity).toContain(VERIFY_GATE_REL);
    expect(parity).toContain("bun-version");

    // Any bun-version that still appears in a workflow (e.g. release preflight
    // setup-bun so version/retag scripts can run before the long suite) must
    // equal the gate pin — otherwise the two rails can disagree on toolchain.
    const gatePin = gate.match(/bun-version:\s*([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
    expect(gatePin).toBeTruthy();
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      for (const match of workflow.matchAll(/bun-version:\s*([0-9]+\.[0-9]+\.[0-9]+)/g)) {
        expect(match[1]).toBe(gatePin);
      }
    }
  });

  test("CI and release reject focused Playwright tests inside the attested canonical run", () => {
    const gate = readVerifyGate();
    expect(gate).not.toContain("--config=e2e/playwright.config.ts --list");
    expect(e2eRunner).toContain("--forbid-only");
    expect(e2eRunner).toContain('THUMBMUX_TEST_ATTESTATION="$THUMBMUX_GUARD_ATTESTATION"');
    expect(e2eConfig).toContain("assertThumbmuxPlaywrightRuntime()");
    expect(e2eHelpers).toContain("assertOwnedContainer()");
    expect(e2eHelpers).not.toContain("|| 'thumbmux-sim'");
    // Both rails still reach the gate (so forbid-only cannot be skipped by
    // one path only).
    expect(ciWorkflow).toContain(`uses: ${VERIFY_GATE_USES}`);
    expect(releaseWorkflow).toContain(`uses: ${VERIFY_GATE_USES}`);
  });

  test("ci parity cannot call an E2E skip a pass and includes publish readiness", () => {
    const skipBranch = parity.slice(
      parity.indexOf('THUMBMUX_SKIP_E2E:-0'),
      parity.indexOf("fi", parity.indexOf('THUMBMUX_SKIP_E2E:-0')) + 2,
    );
    expect(skipBranch).toContain("exit 1");
    expect(parity).toContain("demo builds");
    for (const packageName of ["core", "server", "svelte", "app"]) {
      expect(parity).toContain(
        `(cd ${packageName} && "$THUMBMUX_GUARD_BUN_BIN" run build && "$THUMBMUX_GUARD_BUN_BIN" pm pack)`,
      );
    }
    expect(parity).toContain("./e2e/run-container.sh");
    expect(parity).not.toContain("--config=e2e/playwright.config.ts --list");
    expect(e2eRunner).toContain("--forbid-only");
  });

  test("server pack excludes Python bytecode caches even when they exist beside sources", () => {
    const root = mkdtempSync(join(tmpdir(), "thumbmux-server-pack-hygiene-"));
    const fixture = join(root, "server");
    roots.push(root);
    mkdirSync(join(fixture, "dist/__pycache__"), { recursive: true });
    mkdirSync(join(fixture, "src/integrations/__pycache__"), { recursive: true });

    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, "server/package.json"), "utf8"),
    ) as Record<string, unknown>;
    // Packing the fixture must exercise the real shipped allow/exclude rules,
    // without invoking the production build against intentionally tiny files.
    delete manifest.scripts;
    writeFileSync(join(fixture, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(fixture, "dist/index.js"), "export {};\n");
    writeFileSync(
      join(fixture, "dist/__pycache__/proxy.cpython-312.pyc"),
      "synthetic built bytecode cache\n",
    );
    writeFileSync(join(fixture, "src/index.ts"), "export {};\n");
    writeFileSync(join(fixture, "src/integrations/proxy.py"), "print('fixture')\n");
    writeFileSync(join(fixture, "src/integrations/schema.json"), "{}\n");
    writeFileSync(
      join(fixture, "src/integrations/__pycache__/proxy.cpython-312.pyc"),
      "synthetic bytecode cache\n",
    );
    writeFileSync(join(fixture, "src/integrations/proxy.pyo"), "synthetic optimized bytecode\n");

    const tarball = join(fixture, "server-pack-hygiene.tgz");
    const packed = Bun.spawnSync({
      cmd: [
        process.execPath,
        "pm",
        "pack",
        "--ignore-scripts",
        "--filename",
        "server-pack-hygiene.tgz",
      ],
      cwd: fixture,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (packed.exitCode !== 0) {
      throw new Error(packed.stderr.toString() || packed.stdout.toString());
    }
    const listed = Bun.spawnSync({
      cmd: ["tar", "-tzf", tarball],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (listed.exitCode !== 0) {
      throw new Error(listed.stderr.toString() || listed.stdout.toString());
    }
    const files = listed.stdout.toString().trim().split(/\r?\n/);

    expect(files).toContain("package/dist/index.js");
    expect(files).toContain("package/src/index.ts");
    expect(files).toContain("package/src/integrations/proxy.py");
    expect(files).toContain("package/src/integrations/schema.json");
    expect(files.filter((path) =>
      path.includes("/__pycache__/") || /\.py[co]$/.test(path)
    )).toEqual([]);
  });

  test("CI, release, and local parity materialize a verified remote baseline", () => {
    // CI + release materialize via the shared gate; local parity still does
    // it inline (it has no Actions composite runner).
    const gate = readVerifyGate();
    for (const rail of [gate, parity]) {
      expect(rail).toContain("materialize-contract-baseline.ts");
      // Supplying the root IS the requirement now: contract-check refuses to run
      // without a baseline unless the caller states THUMBMUX_CONTRACT_BASELINE=skip.
      // The old THUMBMUX_CONTRACT_REQUIRE_BASELINE switch is gone, and a rail that
      // still sets it would suggest the default is permissive.
      expect(rail).toContain("THUMBMUX_CONTRACT_BASELINE_ROOT=");
      expect(rail).not.toContain("THUMBMUX_CONTRACT_BASELINE=skip");
      expect(rail).not.toContain("tag --list 'v[0-9]*-dist'");
    }
    expect(ciWorkflow).toContain(`uses: ${VERIFY_GATE_USES}`);
    expect(releaseWorkflow).toContain(`uses: ${VERIFY_GATE_USES}`);
    expect(parity).toContain("THUMBMUX_CONTRACT_REMOTE_URL");
    expect(parity.indexOf("thumbmux_emit_frozen_source_archive"))
      .toBeLessThan(parity.lastIndexOf("materialize-contract-baseline.ts"));
  });

  test("root smoke stages and verifies every advertised contract asset", () => {
    expect(smoke).toContain('cp "$PACKAGE_SOURCE/CONTRACT.md" "$WORK/package/"');
    expect(smoke).toContain('cp -R "$PACKAGE_SOURCE/contract/manifest" "$WORK/package/contract/"');
    expect(smoke).toContain("package/CONTRACT.md");
    for (const subpath of ["core", "server", "svelte", "app"]) {
      expect(smoke).toContain(`package/contract/manifest/${subpath}.json`);
    }
  });

  test("packed Node 18 smoke permanently gates portable replay writer recovery", () => {
    expect(smoke).toContain("/usr/bin/timeout 240 /usr/bin/docker run");
    expect(smoke).toContain('--cidfile "$CID_FILE"');
    expect(smoke).toContain("com.kemcortex.thumbmux.run-id");
    expect(smoke).not.toContain("docker run --rm");
    expect(smoke).toContain("timeout 120 apk add --no-cache python3 tmux");
    expect(smoke).toContain("node18-replay-lock-smoke.mjs");
    expect(smoke).toContain("node node18-replay-lock-smoke.mjs");
    expect(node18ReplayLockSmoke)
      .toContain('createTerminalReplayWorkerClient } from "thumbmux/server"');
    expect(node18ReplayLockSmoke).toContain("Promise.allSettled([");
    expect(node18ReplayLockSmoke).toContain('process.kill(killedPid, "SIGKILL")');
    expect(node18ReplayLockSmoke).toContain("replacement.lastResult.recoveredFromCheckpoint !== true");
    expect(node18ReplayLockSmoke).not.toContain("terminal-replay-materializer");
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

  test("everything the package ships is reachable through its exports map", () => {
    // TM-08. `files` and `exports` answer different questions — what gets
    // installed, and what a consumer is allowed to resolve — and a package with
    // an `exports` map blocks every path the map does not name. So a file can
    // be genuinely present in node_modules and still throw
    // ERR_PACKAGE_PATH_NOT_EXPORTED, which is how the only machine-readable
    // tier inventory shipped for four minor versions without being readable.
    //
    // The invariant is one-directional on purpose: shipping something a
    // consumer cannot reach is the bug. Exporting a path that is not shipped is
    // caught by resolution failing loudly at install time.
    const targets = Object.values(RELEASE_PACKAGE_EXPORTS).flatMap((entry) =>
      typeof entry === "string" ? [entry] : Object.values(entry),
    );
    const unreachable = RELEASE_PACKAGE_FILES.filter((shipped) =>
      !targets.some((target) => target.replace(/^\.\//, "").startsWith(shipped)),
    );
    expect(unreachable).toEqual([]);
  });
});

describe("composite action schema", () => {
  // The gate died on the runner with "Unexpected value 'timeout-minutes'" while
  // every local check was green, because `timeout-minutes` is a WORKFLOW step
  // key that a composite action rejects — and nothing here validates Actions
  // YAML. ci-parity runs the COMMANDS; it has no opinion about the schema they
  // are written in. So the keys a composite step may carry are asserted
  // directly, and the ceiling lives in the shell where it is portable.
  const COMPOSITE_STEP_ONLY_KEYS = [
    "timeout-minutes",
    "continue-on-error",
    "services",
    "strategy",
    "container",
  ] as const;

  test("the shared gate uses no workflow-only step keys", () => {
    const gate = readFileSync(
      join(packageRoot, ".github/actions/verify-gate/action.yml"),
      "utf8",
    );
    const offenders = COMPOSITE_STEP_ONLY_KEYS.filter((key) =>
      new RegExp(`^\\s*${key}\\s*:`, "m").test(gate),
    );
    expect(offenders).toEqual([]);
  });

  test("the long steps still have a ceiling, just a portable one", () => {
    const gate = readFileSync(
      join(packageRoot, ".github/actions/verify-gate/action.yml"),
      "utf8",
    );
    // Removing the key must not quietly remove the limit — that would trade a
    // loud failure for a six-hour hang on the default job timeout.
    expect(gate).toMatch(/run:\s*\/usr\/bin\/timeout\b.*bun test/);
    expect(gate).toMatch(/run:\s*\/usr\/bin\/timeout\b.*run-container\.sh/);
  });
});
